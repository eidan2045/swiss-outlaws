// Real server process + four independent WebSocket clients: accounts, lobbies, sync, chat, friends, reconnect, security.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ClientMsg, ServerMsg, Snapshot, decodeSnapshot, encodeInputs } from '../../src/shared/net/protocol';
import { emptyInput } from '../../src/shared/sim/types';

const PORT = 8799;
let proc: ChildProcess;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-test-'));

class Client {
  ws!: WebSocket;
  msgs: ServerMsg[] = [];
  snap: Snapshot | null = null;
  snaps = 0;
  id = 0;
  token = '';
  seq = 0;
  closed = false;
  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    this.ws.binaryType = 'arraybuffer';
    this.closed = false;
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) { this.snap = decodeSnapshot(data as ArrayBuffer); this.snaps++; }
      else {
        const m = JSON.parse(data.toString()) as ServerMsg;
        this.msgs.push(m);
        if (m.t === 'welcome') this.id = m.id;
        if (m.t === 'auth' && m.token) this.token = m.token;
      }
    });
    this.ws.on('close', () => { this.closed = true; });
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
  }
  send(m: ClientMsg): void { this.ws.send(JSON.stringify(m)); }
  input(mx: number, mz: number, buttons = 0): void {
    const c = emptyInput();
    c.seq = ++this.seq; c.mx = mx; c.mz = mz; c.buttons = buttons;
    this.ws.send(encodeInputs([c]));
  }
  async wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 6000): Promise<Extract<ServerMsg, { t: T }>> {
    const t0 = Date.now();
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${t}`);
      await sleep(20);
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  proc = spawn('npx', ['tsx', 'src/server/index.ts'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STATIC_DIR: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => { out += d; });
  proc.stderr!.on('data', (d) => { out += d; });
  const t0 = Date.now();
  while (!out.includes('listening')) {
    if (Date.now() - t0 > 60000) throw new Error('server did not start:\n' + out);
    await sleep(100);
  }
}, 70000);
afterAll(() => {
  proc?.kill('SIGTERM');
});

describe('multiplayer server', () => {
  const A = new Client(), B = new Client(), C = new Client(), D = new Client();
  let code = '';

  it('answers the health check', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    const j = await r.json();
    expect(j.ok).toBe(true);
  });

  it('registers accounts, rejects bad credentials and duplicate names', async () => {
    await Promise.all([A.connect(), B.connect(), C.connect(), D.connect()]);
    A.send({ t: 'auth', mode: 'register', name: 'Anna', password: 'geheim123' });
    expect((await A.wait('auth')).ok).toBe(true);
    B.send({ t: 'auth', mode: 'register', name: 'anna', password: 'geheim123' });
    expect((await B.wait('auth')).ok).toBe(false); // duplicate (case-insensitive)
    B.send({ t: 'auth', mode: 'register', name: 'Beat', password: '123' });
    expect((await B.wait('auth')).ok).toBe(false); // weak password
    B.send({ t: 'auth', mode: 'register', name: 'Beat', password: 'passwort1' });
    expect((await B.wait('auth')).ok).toBe(true);
    C.send({ t: 'auth', mode: 'login', name: 'Anna', password: 'falsch' });
    expect((await C.wait('auth')).ok).toBe(false);
    C.send({ t: 'auth', mode: 'guest' });
    const g = await C.wait('auth');
    expect(g.ok && g.account!.guest).toBe(true);
    D.send({ t: 'auth', mode: 'guest', name: 'Dani' });
    expect((await D.wait('auth')).account!.name).toBe('Dani');
    // passwords are never stored in clear text
    await sleep(5500);
    const raw = fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8');
    expect(raw).not.toContain('geheim123');
    expect(raw).not.toContain(A.token);
  }, 20000);

  it('ignores game commands before joining and unauthenticated lobby access', async () => {
    const X = new Client();
    await X.connect();
    X.send({ t: 'joinLobby', quick: true });
    expect((await X.wait('error')).code).toBe('auth');
    X.ws.close();
  });

  it('creates a private lobby and lets three more players join by code', async () => {
    A.send({ t: 'joinLobby', create: { private: true, name: 'Testrunde' } });
    const w = await A.wait('welcome');
    code = w.lobby.code;
    expect(code).toMatch(/^[A-Z0-9]{5}$/);
    // private lobbies are not listed
    B.send({ t: 'listLobbies' });
    expect((await B.wait('lobbies')).list.find((l) => l.code === code)).toBeUndefined();
    B.send({ t: 'joinLobby', code: 'XXXXX' });
    expect((await B.wait('error')).code).toBe('nolobby');
    for (const c of [B, C, D]) {
      c.send({ t: 'joinLobby', code });
      const ww = await c.wait('welcome');
      expect(ww.lobby.code).toBe(code);
    }
    const last = (await D.wait('profile', () => true).catch(() => null));
    void last;
    await sleep(400);
    expect(A.snap!.players.length).toBe(3);
    expect(D.snap!.players.length).toBe(3);
  }, 20000);

  it('synchronises movement between four independent clients', async () => {
    const before = B.snap!.players.find((p) => p.id === A.id)!;
    const z0 = before.z;
    // A walks north for ~2 s, everyone else idles
    for (let i = 0; i < 120; i++) {
      A.input(0, -1);
      B.input(0, 0); C.input(0, 0); D.input(0, 0);
      await sleep(1000 / 60);
    }
    await sleep(250);
    for (const c of [B, C, D]) {
      const a = c.snap!.players.find((p) => p.id === A.id)!;
      expect(z0 - a.z).toBeGreaterThan(4);
      expect(z0 - a.z).toBeLessThan(9.5);
    }
    // A's own authoritative state agrees and its inputs were acknowledged
    expect(z0 - A.snap!.me.z).toBeGreaterThan(4);
    expect(A.snap!.ack).toBeGreaterThan(100);
    // the shared world is populated identically for everyone nearby
    expect(A.snap!.vehicles.length).toBeGreaterThan(3);
    const shared = A.snap!.vehicles.filter((v) => B.snap!.vehicles.some((o) => o.id === v.id));
    expect(shared.length).toBeGreaterThan(2);
    // 20 Hz snapshots
    const n0 = B.snaps;
    await sleep(1000);
    expect(B.snaps - n0).toBeGreaterThan(15);
    expect(B.snaps - n0).toBeLessThan(26);
  }, 20000);

  it('relays chat to the lobby and rate-limits spam', async () => {
    A.send({ t: 'cmd', c: { k: 'chat', text: 'Grüezi mitenand!' } });
    for (const c of [B, C, D]) {
      const m = await c.wait('chat', (x) => !x.sys);
      expect(m.text).toBe('Grüezi mitenand!');
      expect(m.name).toBe('Anna');
    }
    for (let i = 0; i < 12; i++) B.send({ t: 'cmd', c: { k: 'chat', text: 'spam ' + i } });
    await sleep(500);
    const got = C.msgs.filter((m) => m.t === 'chat' && !m.sys && m.name === 'Beat').length;
    expect(got).toBeLessThanOrEqual(6);
  }, 20000);

  it('handles friend requests, online status and invitations', async () => {
    A.send({ t: 'friend', op: 'add', name: 'Beat' });
    const req = await B.wait('social', (m) => m.requests.length > 0);
    expect(req.requests[0].name).toBe('Anna');
    B.send({ t: 'friend', op: 'accept', id: req.requests[0].id });
    const sa = await A.wait('social', (m) => m.friends.some((f) => f.name === 'Beat'));
    const beat = sa.friends.find((f) => f.name === 'Beat')!;
    expect(beat.online).toBe(true);
    A.send({ t: 'friend', op: 'invite', id: beat.id });
    const inv = await B.wait('social', (m) => m.invites.length > 0);
    expect(inv.invites[0]).toEqual({ from: 'Anna', code });
  }, 20000);

  it('keeps the avatar across a dropped connection and restores it via token', async () => {
    const before = B.snap!.players.find((p) => p.id === A.id)!;
    const idA = A.id;
    A.ws.terminate(); // hard drop, no close handshake
    await sleep(800);
    // the others are told, the avatar stays in the world during the grace period
    await B.wait('chat', (m) => !!m.sys && m.text.includes('Verbindung verloren'));
    const A2 = new Client();
    await A2.connect();
    A2.send({ t: 'auth', mode: 'token', token: A.token });
    expect((await A2.wait('auth')).ok).toBe(true);
    A2.send({ t: 'joinLobby', code });
    const w = await A2.wait('welcome');
    expect(w.id).toBe(idA);
    await sleep(300);
    expect(Math.abs(A2.snap!.me.z - before.z)).toBeLessThan(1.5);
    expect(A2.snap!.players.length).toBe(3);
    Object.assign(A, A2);
  }, 20000);

  it('persists progress server-side and never trusts client-side money', async () => {
    const money = A.snap!.money;
    // there is no message that sets money; a forged purchase far from the dealer changes nothing
    A.send({ t: 'cmd', c: { k: 'buy', item: 'vehicle', id: 2 } });
    A.send({ t: 'cmd', c: { k: 'spawnOwned', spec: 2 } });
    A.send({ t: 'cmd', c: { k: 'nonsense' } as never });
    A.ws.send(Buffer.from([1, 255, 1, 2, 3])); // malformed binary
    A.ws.send('{"t":"cmd","c":null}');
    await sleep(500);
    expect(A.closed).toBe(false);
    expect(A.snap!.money).toBe(money);
    expect(A.snap!.myVeh).toBe(0);
  }, 20000);

  it('disconnects clients that flood the socket', async () => {
    const F = new Client();
    await F.connect();
    for (let i = 0; i < 400; i++) F.ws.send('{"t":"ping","c":1}');
    await sleep(600);
    expect(F.closed).toBe(true);
  }, 20000);
});
