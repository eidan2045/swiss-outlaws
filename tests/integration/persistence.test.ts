// Persistence across a full server restart, lobby restore by code, profile position/inventory, friend search by ID,
// appearance sync to other players and the sandbox lobby flag.
import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ClientMsg, ServerMsg, Snapshot, decodeSnapshot, encodeInputs, unpackAppearance } from '../../src/shared/net/protocol';
import { emptyInput } from '../../src/shared/sim/types';

const PORT = 8798;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-persist-'));
let proc: ChildProcess | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startServer(): Promise<void> {
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STATIC_DIR: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => { out += d; });
  proc.stderr!.on('data', (d) => { out += d; });
  const t0 = Date.now();
  while (!out.includes('listening')) {
    if (Date.now() - t0 > 60000) throw new Error('server did not start:\n' + out);
    await sleep(100);
  }
}
async function stopServer(): Promise<void> {
  if (!proc) return;
  const p = proc;
  proc = null;
  await new Promise<void>((res) => { p.once('exit', () => res()); p.kill('SIGTERM'); });
}
class C {
  ws!: WebSocket; msgs: ServerMsg[] = []; snap: Snapshot | null = null; token = ''; id = ''; seq = 0;
  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (d, bin) => {
      if (bin) this.snap = decodeSnapshot(d as ArrayBuffer);
      else { const m = JSON.parse(d.toString()) as ServerMsg; this.msgs.push(m); if (m.t === 'auth' && m.token) { this.token = m.token; this.id = m.account!.id; } }
    });
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
  }
  send(m: ClientMsg): void { this.ws.send(JSON.stringify(m)); }
  async wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 8000): Promise<Extract<ServerMsg, { t: T }>> {
    const t0 = Date.now();
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      if (Date.now() - t0 > ms) throw new Error('timeout ' + t);
      await sleep(20);
    }
  }
  walk(ms: number): Promise<void> {
    return (async () => { const end = Date.now() + ms; while (Date.now() < end) { const c = emptyInput(); c.seq = ++this.seq; c.mz = -1; this.ws.send(encodeInputs([c])); await sleep(16); } })();
  }
}
afterAll(async () => { await stopServer(); });

describe('persistence, friends and sandbox', () => {
  it('restores lobby, position, inventory and outfits after a server restart', async () => {
    await startServer();
    const A = new C(), B = new C();
    await Promise.all([A.connect(), B.connect()]);
    A.send({ t: 'auth', mode: 'register', name: 'Ueli', password: 'matterhorn1' });
    B.send({ t: 'auth', mode: 'register', name: 'Vreni', password: 'matterhorn2' });
    await A.wait('auth'); await B.wait('auth');

    // sandbox is only honoured for private lobbies
    A.send({ t: 'joinLobby', create: { private: false, sandbox: true } });
    expect((await A.wait('welcome')).lobby.sandbox).toBe(false);
    A.send({ t: 'joinLobby', create: { private: true, sandbox: true, name: 'Sandkasten' } });
    const w = await A.wait('welcome');
    expect(w.lobby.sandbox).toBe(true);
    const code = w.lobby.code;
    B.send({ t: 'joinLobby', code });
    await B.wait('welcome');

    // appearance change reaches the other player
    A.send({ t: 'appearance', a: { skin: 1, hair: 2, hairStyle: 4, jacket: 5, pants: 3, shoes: 2, build: 1, hat: 2, top: 1, legs: 2, feet: 1, acc: 3 } });
    const j = await B.wait('join', (m) => m.p.name === 'Ueli' && unpackAppearance(m.p.look).top === 1);
    expect(unpackAppearance(j.p.look)).toMatchObject({ hairStyle: 4, hat: 2, legs: 2, feet: 1, acc: 3 });
    A.send({ t: 'outfits', list: [{ top: 3, jacket: 0 }] as never });

    // friend search by unique id and by partial name
    B.send({ t: 'friend', op: 'search', name: '#' + A.id });
    expect((await B.wait('search')).results[0]).toMatchObject({ id: A.id, name: 'Ueli', online: true });
    B.send({ t: 'friend', op: 'search', name: 'uel' });
    expect((await B.wait('search')).results.some((r) => r.id === A.id)).toBe(true);
    B.send({ t: 'friend', op: 'add', id: A.id });
    const req = await A.wait('social', (m) => m.requests.length > 0);
    A.send({ t: 'friend', op: 'accept', id: req.requests[0].id });
    const sb = await B.wait('social', (m) => m.friends.some((f) => f.name === 'Ueli'));
    expect(sb.friends[0]).toMatchObject({ online: true, lobby: code });

    // A walks, buys ammo (inventory) – then the server goes down
    await A.walk(1500);
    await sleep(300);
    A.send({ t: 'cmd', c: { k: 'buy', item: 'ammo' } });
    await sleep(400);
    const before = { x: A.snap!.me.x, z: A.snap!.me.z, ammo: A.snap!.ammo, money: A.snap!.money };
    expect(before.ammo).toBe(96);
    A.ws.close(); B.ws.close();
    await sleep(400);
    await stopServer();
    await startServer();

    // after the restart: token still valid, same lobby code is recreated, progress restored
    const A2 = new C();
    await A2.connect();
    A2.send({ t: 'auth', mode: 'token', token: A.token });
    expect((await A2.wait('auth')).ok).toBe(true);
    const prof = await A2.wait('profile');
    expect(prof.profile.outfits?.[0]?.top).toBe(3);
    expect(prof.profile.appearance.acc).toBe(3);
    A2.send({ t: 'joinLobby', code, resume: true });
    const w2 = await A2.wait('welcome');
    expect(w2.lobby.code).toBe(code);
    expect(w2.lobby.sandbox).toBe(true);
    await sleep(400);
    expect(Math.hypot(A2.snap!.me.x - before.x, A2.snap!.me.z - before.z)).toBeLessThan(1.5);
    expect(A2.snap!.ammo).toBe(before.ammo);
    expect(A2.snap!.money).toBe(before.money);

    // friendship survived the restart
    A2.send({ t: 'friend', op: 'list' });
    expect((await A2.wait('social', (m) => m.friends.length > 0)).friends[0].name).toBe('Vreni');

    // unknown codes with resume fall back to a fresh world with the saved progress
    const A3 = new C();
    await A3.connect();
    A3.send({ t: 'auth', mode: 'token', token: A.token });
    await A3.wait('auth');
    A3.send({ t: 'joinLobby', code: 'ZZZZZ', resume: true });
    const w3 = await A3.wait('welcome');
    expect(w3.lobby.code).not.toBe('ZZZZZ');
    A3.ws.close();
  }, 120000);
});
