// Swiss Outlaws game server: HTTP (health + optional static client) and WebSocket (auth, lobbies, friends, game rooms).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { buildWorld } from '../shared/world/world';
import { GameRoom, RoomPlayer } from '../shared/sim/room';
import { ClientMsg, FriendInfo, LobbyInfo, Pkt, Reader, ServerMsg, decodeInputs } from '../shared/net/protocol';
import { DT } from '../shared/sim/types';
import { Account, Store } from './store';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 8);
const STATIC_DIR = process.env.STATIC_DIR || path.resolve('dist');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

console.log('[server] generating world …');
const world = buildWorld();
console.log(`[server] world ready in ${world.genMs} ms (${world.roads.edges.length} road edges, ${world.city.buildings.length} buildings)`);
const store = new Store(DATA_DIR);

interface Lobby {
  room: GameRoom;
  code: string;
  emptySince: number;
  acc: number;
  last: number;
  invited: Set<string>;
}
interface Conn {
  ws: WebSocket;
  ip: string;
  account: Account | null;
  lobby: Lobby | null;
  player: RoomPlayer | null;
  msgCount: number;
  msgWindow: number;
  alive: boolean;
}
const lobbies = new Map<string, Lobby>();
const online = new Map<string, Conn>(); // account id → connection
const authAttempts = new Map<string, { n: number; t: number }>();

function send(c: Conn, m: ServerMsg | ArrayBuffer): void {
  if (c.ws.readyState !== WebSocket.OPEN) return;
  if (m instanceof ArrayBuffer) c.ws.send(m, { binary: true });
  else c.ws.send(JSON.stringify(m));
}
function newCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = '';
    for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
    if (!lobbies.has(s)) return s;
  }
}
function createLobby(name: string, priv: boolean): Lobby {
  const code = newCode();
  const room = new GameRoom(world, {
    code, name: name.slice(0, 32) || 'Lobby', private: priv, maxPlayers: MAX_PLAYERS, seed: Math.floor(Math.random() * 1e9),
    saveProfile: (accountId, profile) => {
      const a = store.get(accountId);
      if (a) { a.profile = profile; store.touch(); }
    },
  });
  const l: Lobby = { room, code, emptySince: Date.now(), acc: 0, last: performance.now(), invited: new Set() };
  lobbies.set(code, l);
  console.log(`[lobby] created ${code} "${name}" (${priv ? 'private' : 'public'})`);
  return l;
}
function lobbyList(): LobbyInfo[] {
  return [...lobbies.values()].filter((l) => !l.room.opts.private).map((l) => l.room.info).sort((a, b) => b.players - a.players).slice(0, 30);
}
function social(c: Conn): void {
  const a = c.account;
  if (!a) return;
  const friends: FriendInfo[] = a.friends.map((id) => {
    const f = store.get(id);
    const oc = online.get(id);
    const lob = oc?.lobby;
    return { id, name: f?.name ?? '?', online: !!oc, lobby: lob && (!lob.room.opts.private || lob.invited.has(a.id)) ? lob.code : undefined };
  });
  const requests = a.requests.map((id) => ({ id, name: store.get(id)?.name ?? '?' }));
  send(c, { t: 'social', friends, requests, invites: [] });
}
function notifyFriends(a: Account): void {
  for (const id of a.friends) {
    const oc = online.get(id);
    if (oc) social(oc);
  }
}
function leaveLobby(c: Conn, graceful: boolean): void {
  if (c.lobby && c.player) {
    if (graceful) c.lobby.room.removePlayer(c.player.id);
    else c.lobby.room.disconnectPlayer(c.player.id);
    if (c.lobby.room.playerCount === 0) c.lobby.emptySince = Date.now();
  }
  c.lobby = null;
  c.player = null;
  if (c.account) notifyFriends(c.account);
}
function joinLobby(c: Conn, l: Lobby): void {
  const a = c.account!;
  if (c.lobby) leaveLobby(c, true);
  // an existing (disconnected) avatar of this account may rejoin even when the lobby is full
  const rejoin = [...l.room.players.values()].some((p) => p.accountId === a.id);
  if (!rejoin && l.room.playerCount >= l.room.opts.maxPlayers) {
    send(c, { t: 'error', code: 'full', text: 'Diese Lobby ist voll.' });
    return;
  }
  a.profile.name = a.name;
  c.player = l.room.addPlayer(a.id, a.profile, (m) => send(c, m));
  c.lobby = l;
  notifyFriends(a);
}
function rateOk(ip: string): boolean {
  const now = Date.now();
  const r = authAttempts.get(ip);
  if (!r || now - r.t > 60000) { authAttempts.set(ip, { n: 1, t: now }); return true; }
  return ++r.n <= 12;
}
function authed(c: Conn, a: Account, token: string): void {
  // one session per account: the newer connection wins
  const prev = online.get(a.id);
  if (prev && prev !== c) {
    send(prev, { t: 'error', code: 'replaced', text: 'Du hast dich an einem anderen Ort angemeldet.' });
    leaveLobby(prev, false);
    prev.account = null;
    prev.ws.close(4001, 'replaced');
  }
  c.account = a;
  online.set(a.id, c);
  send(c, { t: 'auth', ok: true, token, account: { id: a.id, name: a.name, guest: a.guest } });
  send(c, { t: 'profile', profile: a.profile });
  social(c);
  notifyFriends(a);
}

function onJson(c: Conn, m: ClientMsg): void {
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  if (m.t === 'ping') { send(c, { t: 'pong', c: Number(m.c) || 0, s: c.lobby?.room.tick ?? 0 }); return; }
  if (m.t === 'auth') {
    if (!rateOk(c.ip)) { send(c, { t: 'auth', ok: false, text: 'Zu viele Versuche. Bitte warte eine Minute.' }); return; }
    if (m.mode === 'token') {
      const a = store.byTokenValue(String(m.token ?? ''));
      if (a) authed(c, a, String(m.token));
      else send(c, { t: 'auth', ok: false, text: 'Sitzung abgelaufen. Bitte neu anmelden.' });
    } else if (m.mode === 'guest') {
      const r = store.guest(typeof m.name === 'string' ? m.name : undefined);
      authed(c, r.account, r.token);
    } else if (m.mode === 'register') {
      const r = store.register(String(m.name ?? ''), String(m.password ?? ''));
      if (r.ok) authed(c, r.account, r.token);
      else send(c, { t: 'auth', ok: false, text: r.text });
    } else if (m.mode === 'login') {
      const r = store.login(String(m.name ?? ''), String(m.password ?? ''));
      if (r.ok) authed(c, r.account, r.token);
      else send(c, { t: 'auth', ok: false, text: r.text });
    }
    return;
  }
  const a = c.account;
  if (!a) { send(c, { t: 'error', code: 'auth', text: 'Nicht angemeldet.' }); return; }
  switch (m.t) {
    case 'listLobbies': send(c, { t: 'lobbies', list: lobbyList() }); break;
    case 'joinLobby': {
      if (m.appearance && typeof m.appearance === 'object') {
        const ap = m.appearance, cl = (v: unknown, n: number) => Math.max(0, Math.min(n, Number(v) | 0));
        a.profile.appearance = { skin: cl(ap.skin, 4), hair: cl(ap.hair, 5), hairStyle: cl(ap.hairStyle, 3), jacket: cl(ap.jacket, 15), pants: cl(ap.pants, 7), shoes: cl(ap.shoes, 3), build: cl(ap.build, 2), hat: cl(ap.hat, 1) };
        store.touch();
      }
      let l: Lobby | undefined;
      if (m.code) {
        l = lobbies.get(String(m.code).toUpperCase().trim());
        if (!l) { send(c, { t: 'error', code: 'nolobby', text: 'Lobby nicht gefunden.' }); return; }
      } else if (m.create) l = createLobby(String(m.create.name || `${a.name}s Lobby`), !!m.create.private);
      else {
        l = [...lobbies.values()].filter((x) => !x.room.opts.private && x.room.playerCount < x.room.opts.maxPlayers).sort((x, y) => y.room.playerCount - x.room.playerCount)[0];
        if (!l) l = createLobby('Zürich öffentlich', false);
      }
      joinLobby(c, l);
      break;
    }
    case 'leaveLobby': leaveLobby(c, true); break;
    case 'cmd': if (c.lobby && c.player) c.lobby.room.handleCommand(c.player.id, m.c); break;
    case 'appearance': break; // applied on the next join
    case 'report': {
      const target = c.lobby?.room.players.get(Number(m.player));
      if (target) {
        store.reports.push({ at: Date.now(), by: a.id, target: target.accountId, reason: String(m.reason ?? '').slice(0, 200) });
        console.log(`[report] ${a.name} → ${target.name}: ${String(m.reason ?? '').slice(0, 200)}`);
        send(c, { t: 'toast', text: 'Meldung wurde übermittelt.', kind: 'info' });
      }
      break;
    }
    case 'friend': {
      if (m.op === 'list') { social(c); break; }
      if (m.op === 'add') {
        const f = store.findByName(String(m.name ?? ''));
        if (!f || f.id === a.id) { send(c, { t: 'toast', text: 'Spieler nicht gefunden.', kind: 'bad' }); break; }
        if (a.friends.includes(f.id)) { send(c, { t: 'toast', text: 'Ihr seid bereits befreundet.', kind: 'info' }); break; }
        if (f.blocked.includes(a.id)) { send(c, { t: 'toast', text: 'Anfrage gesendet.', kind: 'info' }); break; }
        if (a.requests.includes(f.id)) {
          // the other side already asked → becomes a friendship
          a.requests = a.requests.filter((x) => x !== f.id);
          a.friends.push(f.id); f.friends.push(a.id);
        } else if (!f.requests.includes(a.id)) f.requests.push(a.id);
        store.touch();
        send(c, { t: 'toast', text: 'Anfrage gesendet.', kind: 'info' });
        social(c);
        const oc = online.get(f.id);
        if (oc) { social(oc); send(oc, { t: 'toast', text: `Freundschaftsanfrage von ${a.name}`, kind: 'info' }); }
      } else if (m.op === 'accept' || m.op === 'decline') {
        const id = String(m.id ?? '');
        if (!a.requests.includes(id)) break;
        a.requests = a.requests.filter((x) => x !== id);
        const f = store.get(id);
        if (m.op === 'accept' && f) {
          if (!a.friends.includes(id)) a.friends.push(id);
          if (!f.friends.includes(a.id)) f.friends.push(a.id);
          const oc = online.get(id);
          if (oc) { social(oc); send(oc, { t: 'toast', text: `${a.name} hat deine Anfrage angenommen.`, kind: 'good' }); }
        }
        store.touch();
        social(c);
      } else if (m.op === 'remove') {
        const id = String(m.id ?? '');
        a.friends = a.friends.filter((x) => x !== id);
        const f = store.get(id);
        if (f) f.friends = f.friends.filter((x) => x !== a.id);
        store.touch();
        social(c);
        const oc = online.get(id);
        if (oc) social(oc);
      } else if (m.op === 'invite') {
        const id = String(m.id ?? '');
        const oc = online.get(id);
        if (!c.lobby || !a.friends.includes(id)) break;
        c.lobby.invited.add(id);
        if (oc) {
          send(oc, { t: 'social', friends: [], requests: [], invites: [{ from: a.name, code: c.lobby.code }] });
          send(c, { t: 'toast', text: 'Einladung gesendet.', kind: 'info' });
        } else send(c, { t: 'toast', text: 'Dieser Freund ist offline.', kind: 'bad' });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- http
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/health' || url.pathname === '/api/info') {
    let players = 0;
    for (const l of lobbies.values()) players += l.room.playerCount;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'swiss-outlaws', lobbies: lobbies.size, players, uptime: Math.round(process.uptime()), maxPlayers: MAX_PLAYERS }));
    return;
  }
  // optional static hosting of the built client (single-service deployment)
  let file = path.normalize(path.join(STATIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC_DIR, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Swiss Outlaws server is running. Build the client (npm run build) to serve it from here.'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) { ws.close(4003, 'origin'); return; }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  const c: Conn = { ws, ip, account: null, lobby: null, player: null, msgCount: 0, msgWindow: Date.now(), alive: true };
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    // flood protection
    const now = Date.now();
    if (now - c.msgWindow > 1000) { c.msgWindow = now; c.msgCount = 0; }
    if (++c.msgCount > 240) { ws.close(4008, 'flood'); return; }
    try {
      if (isBinary) {
        if (!c.lobby || !c.player) return;
        const buf = data as Buffer;
        const r = new Reader(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        if (r.u8() === Pkt.Input) c.lobby.room.handleInputs(c.player.id, decodeInputs(r));
      } else {
        const text = data.toString();
        if (text.length > 4096) return;
        onJson(c, JSON.parse(text) as ClientMsg);
      }
    } catch (e) {
      console.error('[ws] bad message', (e as Error).message);
    }
  });
  ws.on('close', () => {
    leaveLobby(c, false);
    if (c.account && online.get(c.account.id) === c) {
      online.delete(c.account.id);
      notifyFriends(c.account);
    }
  });
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) {
    const c = [...online.values()].find((x) => x.ws === ws);
    if (c) {
      if (!c.alive) { ws.terminate(); continue; }
      c.alive = false;
    }
    ws.ping();
  }
}, 15000).unref();

// ---------------------------------------------------------------- simulation loop
setInterval(() => {
  const now = performance.now();
  for (const l of lobbies.values()) {
    const active = l.room.players.size > 0;
    if (!active) {
      l.last = now;
      if (Date.now() - l.emptySince > 60000) { lobbies.delete(l.code); console.log(`[lobby] closed ${l.code}`); }
      continue;
    }
    if (l.room.playerCount > 0) l.emptySince = Date.now();
    l.acc += (now - l.last) / 1000;
    l.last = now;
    if (l.acc > 0.25) l.acc = 0.25; // never spiral after a stall
    while (l.acc >= DT) {
      l.room.step();
      l.acc -= DT;
    }
  }
}, 8);

process.on('SIGTERM', () => { store.flush(); process.exit(0); });
process.on('SIGINT', () => { store.flush(); process.exit(0); });
server.listen(PORT, () => console.log(`[server] listening on :${PORT} (max ${MAX_PLAYERS} players per lobby)`));
