// Wire protocol: binary input + snapshot packets, JSON for everything else.
import { CharState, InputCmd, VehState, newChar, newVeh } from '../sim/types';

export const PROTOCOL_VERSION = 4;
export const SNAPSHOT_HZ = 20;

export const enum Pkt {
  Input = 1,
  Snapshot = 2,
}

// ---------------------------------------------------------------- appearance / profile
export interface Appearance {
  skin: number; // palette index
  hair: number; // hair colour index
  hairStyle: number; // 0 short, 1 long, 2 bald, 3 full, 4 ponytail, 5 bun, 6 undercut
  jacket: number; // top colour index
  pants: number;
  shoes: number;
  build: number; // 0 slim .. 2 broad
  hat: number; // 0 none, 1 cap, 2 beanie, 3 hat
  top: number; // 0 jacket, 1 hoodie, 2 t-shirt, 3 suit, 4 puffer
  legs: number; // 0 jeans, 1 shorts, 2 track pants
  feet: number; // 0 sneakers, 1 boots, 2 dress shoes
  acc: number; // 0 none, 1 glasses, 2 sunglasses, 3 backpack, 4 scarf
}
/** number of options per appearance field (order = packing order) */
export const APPEARANCE_RANGES: [keyof Appearance, number][] = [
  ['skin', 5], ['hair', 6], ['hairStyle', 7], ['jacket', 16], ['pants', 8], ['shoes', 4], ['build', 3], ['hat', 4], ['top', 5], ['legs', 3], ['feet', 3], ['acc', 5],
];
export function defaultAppearance(seed = 1): Appearance {
  const r = (n: number, k: number) => Math.abs(Math.imul(seed + k * 7919, 2654435761) >>> 8) % n;
  const a = {} as Appearance;
  APPEARANCE_RANGES.forEach(([k, n], i) => { a[k] = r(n, i + 1); });
  // most people wear no hat or accessory
  if (r(3, 20)) a.hat = 0;
  if (r(3, 21)) a.acc = 0;
  if (a.hairStyle === 2 && r(2, 22)) a.hairStyle = 0;
  return a;
}
/** Clamp untrusted appearance data to valid indices (missing fields → 0). */
export function sanitizeAppearance(src: unknown): Appearance {
  const o = (src && typeof src === 'object' ? src : {}) as Record<string, unknown>;
  const a = {} as Appearance;
  for (const [k, n] of APPEARANCE_RANGES) a[k] = Math.max(0, Math.min(n - 1, Number(o[k]) | 0));
  return a;
}
export function packAppearance(a: Appearance): number {
  let v = 0;
  for (let i = APPEARANCE_RANGES.length - 1; i >= 0; i--) {
    const [k, n] = APPEARANCE_RANGES[i];
    v = v * n + Math.max(0, Math.min(n - 1, a[k] | 0));
  }
  return v;
}
export function unpackAppearance(v: number): Appearance {
  const a = {} as Appearance;
  for (const [k, n] of APPEARANCE_RANGES) { a[k] = v % n; v = Math.floor(v / n); }
  return a;
}

export interface Profile {
  name: string;
  appearance: Appearance;
  money: number;
  xp: number;
  /** owned vehicle spec ids */
  garage: number[];
  /** collected secret ids */
  secrets: number[];
  /** finished mission ids */
  missions: string[];
  stats: { km: number; races: number; deliveries: number; busted: number; wasted: number; playSeconds: number };
  /** best race times in seconds by race id */
  best: Record<string, number>;
  /** saved outfits */
  outfits?: Appearance[];
  /** inventory */
  ammo?: number;
  weapon?: number;
  /** last world position */
  pos?: { x: number; y: number; z: number; yaw: number; lobby?: string; at: number };
  /** client settings synced to the account */
  settings?: Record<string, number | boolean | string>;
}
export function newProfile(name: string, seed = 1): Profile {
  return { name, appearance: defaultAppearance(seed), money: 1500, xp: 0, garage: [], secrets: [], missions: [], stats: { km: 0, races: 0, deliveries: 0, busted: 0, wasted: 0, playSeconds: 0 }, best: {} };
}
export function levelForXp(xp: number): number {
  // 1 → 2 at 500 xp, then growing steps
  let lvl = 1, need = 500, left = xp;
  while (left >= need && lvl < 50) { left -= need; lvl++; need = Math.round(need * 1.28); }
  return lvl;
}
export function xpProgress(xp: number): { level: number; cur: number; need: number } {
  let lvl = 1, need = 500, left = xp;
  while (left >= need && lvl < 50) { left -= need; lvl++; need = Math.round(need * 1.28); }
  return { level: lvl, cur: left, need };
}

// ---------------------------------------------------------------- JSON messages
export interface MissionView {
  id: string;
  title: string;
  /** current objective text */
  text: string;
  /** objective marker */
  x: number;
  z: number;
  r: number;
  /** seconds remaining or -1 */
  timer: number;
  step: number;
  steps: number;
  /** extra numeric state shown in the HUD (e.g. cargo condition, checkpoint index) */
  info?: string;
  kind: 'story' | 'race' | 'delivery';
}
export type ServerMsg =
  | { t: 'welcome'; id: number; protocol: number; tick: number; lobby: LobbyInfo; profile: Profile; players: PlayerInfo[]; secrets: number[] }
  | { t: 'join'; p: PlayerInfo }
  | { t: 'leave'; id: number }
  | { t: 'chat'; from: number; name: string; text: string; sys?: boolean }
  | { t: 'toast'; text: string; kind?: 'info' | 'good' | 'bad' | 'money' }
  | { t: 'profile'; profile: Profile }
  | { t: 'mission'; m: MissionView | null; result?: { ok: boolean; title: string; reward: number; xp: number; detail?: string } }
  | { t: 'shot'; by: number; x: number; y: number; z: number; hx: number; hy: number; hz: number; hit: number }
  | { t: 'fx'; kind: 'crash' | 'explode' | 'prop' | 'horn' | 'punch' | 'siren' | 'cash'; x: number; y: number; z: number; a?: number }
  | { t: 'wasted'; by?: string; busted?: boolean; fee: number }
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; code: string; text: string }
  | { t: 'social'; friends: FriendInfo[]; requests: { id: string; name: string }[]; invites: { from: string; code: string }[] }
  | { t: 'lobbies'; list: LobbyInfo[] }
  | { t: 'auth'; ok: boolean; token?: string; account?: { id: string; name: string; guest: boolean }; text?: string }
  | { t: 'search'; results: { id: string; name: string; online: boolean; friend: boolean; pending: boolean }[] };

export interface PlayerInfo { id: number; name: string; look: number; level: number; account?: string }
export interface LobbyInfo { code: string; name: string; players: number; max: number; private: boolean; host?: string; sandbox?: boolean }
export interface FriendInfo { id: string; name: string; online: boolean; lobby?: string }

export type ClientMsg =
  | { t: 'auth'; mode: 'guest' | 'login' | 'register' | 'token'; name?: string; password?: string; token?: string }
  | { t: 'joinLobby'; code?: string; create?: { private: boolean; name?: string; sandbox?: boolean }; quick?: boolean; appearance?: Appearance; resume?: boolean }
  | { t: 'leaveLobby' }
  | { t: 'listLobbies' }
  | { t: 'cmd'; c: Command }
  | { t: 'ping'; c: number }
  | { t: 'friend'; op: 'add' | 'accept' | 'decline' | 'remove' | 'invite' | 'list' | 'search'; name?: string; id?: string }
  | { t: 'outfits'; list: Appearance[] }
  | { t: 'settings'; s: Record<string, number | boolean | string> }
  | { t: 'report'; player: number; reason: string }
  | { t: 'appearance'; a: Appearance };

export type Command =
  | { k: 'use' } // enter / exit vehicle, interact
  | { k: 'chat'; text: string }
  | { k: 'respawn' }
  | { k: 'toggle'; what: 'lights' | 'siren' }
  | { k: 'mission'; op: 'start' | 'abort'; id?: string }
  | { k: 'buy'; item: 'vehicle' | 'repair' | 'ammo'; id?: number }
  | { k: 'spawnOwned'; spec: number }
  | { k: 'weapon'; slot: number };

// ---------------------------------------------------------------- binary helpers
export class Writer {
  buf: ArrayBuffer;
  dv: DataView;
  o = 0;
  constructor(size = 4096) {
    this.buf = new ArrayBuffer(size);
    this.dv = new DataView(this.buf);
  }
  private need(n: number): void {
    if (this.o + n <= this.buf.byteLength) return;
    const nb = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.o + n));
    new Uint8Array(nb).set(new Uint8Array(this.buf));
    this.buf = nb;
    this.dv = new DataView(nb);
  }
  u8(v: number): void { this.need(1); this.dv.setUint8(this.o, v & 255); this.o += 1; }
  i8(v: number): void { this.need(1); this.dv.setInt8(this.o, Math.max(-128, Math.min(127, Math.round(v)))); this.o += 1; }
  u16(v: number): void { this.need(2); this.dv.setUint16(this.o, v & 65535, true); this.o += 2; }
  i16(v: number): void { this.need(2); this.dv.setInt16(this.o, Math.max(-32768, Math.min(32767, Math.round(v))), true); this.o += 2; }
  u32(v: number): void { this.need(4); this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; }
  i32(v: number): void { this.need(4); this.dv.setInt32(this.o, v | 0, true); this.o += 4; }
  f32(v: number): void { this.need(4); this.dv.setFloat32(this.o, v, true); this.o += 4; }
  done(): ArrayBuffer { return this.buf.slice(0, this.o); }
  reset(): void { this.o = 0; }
}
export class Reader {
  dv: DataView;
  o = 0;
  constructor(buf: ArrayBuffer | Uint8Array) {
    this.dv = buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get left(): number { return this.dv.byteLength - this.o; }
  u8(): number { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  i8(): number { const v = this.dv.getInt8(this.o); this.o += 1; return v; }
  u16(): number { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16(): number { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u32(): number { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32(): number { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  f32(): number { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
}
const ANG = 32767 / Math.PI;

// ---------------------------------------------------------------- input packet
export function encodeInputs(cmds: InputCmd[]): ArrayBuffer {
  const w = new Writer(2 + cmds.length * 12);
  w.u8(Pkt.Input);
  w.u8(cmds.length);
  for (const c of cmds) {
    w.u32(c.seq);
    w.i8(c.mx * 127);
    w.i8(c.mz * 127);
    w.i16(c.yaw * ANG);
    w.i16(c.pitch * ANG);
    w.u16(c.buttons);
  }
  return w.done();
}
export function decodeInputs(r: Reader): InputCmd[] {
  const n = Math.min(8, r.u8());
  const out: InputCmd[] = [];
  for (let i = 0; i < n && r.left >= 12; i++) {
    out.push({ seq: r.u32(), mx: r.i8() / 127, mz: r.i8() / 127, yaw: r.i16() / ANG, pitch: r.i16() / ANG, buttons: r.u16() });
  }
  return out;
}
/** Quantise an input exactly like the wire does, so prediction uses the same values as the server. */
export function quantizeInput(c: InputCmd): InputCmd {
  c.mx = Math.max(-128, Math.min(127, Math.round(c.mx * 127))) / 127;
  c.mz = Math.max(-128, Math.min(127, Math.round(c.mz * 127))) / 127;
  c.yaw = Math.max(-32768, Math.min(32767, Math.round(c.yaw * ANG))) / ANG;
  c.pitch = Math.max(-32768, Math.min(32767, Math.round(c.pitch * ANG))) / ANG;
  return c;
}

// ---------------------------------------------------------------- snapshot
export interface SnapPlayer { id: number; x: number; y: number; z: number; yaw: number; vx: number; vz: number; flags: number; mode: number; hp: number; veh: number; seat: number; pitch: number; anim: number; wanted: number }
export interface SnapVehicle { id: number; spec: number; color: number; x: number; y: number; z: number; yaw: number; pitch: number; roll: number; speed: number; steer: number; rpm: number; flags: number; hp: number; slip: number; driver: number }
export interface SnapNpc { id: number; x: number; y: number; z: number; yaw: number; state: number; look: number; speed: number; kind: number }
export interface Snapshot {
  tick: number;
  ack: number;
  hours: number;
  weather: { cover: number; rain: number; fog: number; snow: number; wind: number };
  wanted: number;
  money: number;
  ammo: number;
  weapon: number;
  me: CharState;
  myVeh: number;
  mySeat: number;
  veh: VehState | null;
  players: SnapPlayer[];
  vehicles: SnapVehicle[];
  npcs: SnapNpc[];
}

export function writeChar(w: Writer, c: CharState): void {
  w.f32(c.x); w.f32(c.y); w.f32(c.z); w.f32(c.vx); w.f32(c.vy); w.f32(c.vz); w.f32(c.yaw);
  w.u8(c.flags); w.u8(c.mode); w.f32(c.modeT); w.f32(c.hp); w.f32(c.stamina); w.u16(c.prevButtons); w.f32(c.meleeT); w.f32(c.fireT);
  w.f32(c.mx); w.f32(c.my); w.f32(c.mz);
}
export function readChar(r: Reader, c: CharState): CharState {
  c.x = r.f32(); c.y = r.f32(); c.z = r.f32(); c.vx = r.f32(); c.vy = r.f32(); c.vz = r.f32(); c.yaw = r.f32();
  c.flags = r.u8(); c.mode = r.u8(); c.modeT = r.f32(); c.hp = r.f32(); c.stamina = r.f32(); c.prevButtons = r.u16(); c.meleeT = r.f32(); c.fireT = r.f32();
  c.mx = r.f32(); c.my = r.f32(); c.mz = r.f32();
  return c;
}
export function writeVeh(w: Writer, v: VehState): void {
  w.f32(v.x); w.f32(v.y); w.f32(v.z); w.f32(v.yaw); w.f32(v.pitch); w.f32(v.roll); w.f32(v.vx); w.f32(v.vy); w.f32(v.vz); w.f32(v.yawRate);
  w.f32(v.steer); w.f32(v.rpm); w.i8(v.gear); w.f32(v.shiftT); w.u16(v.flags); w.f32(v.hp); w.f32(v.slipF); w.f32(v.slipR); w.f32(v.ax); w.f32(v.ay); w.f32(v.throttle);
}
export function readVeh(r: Reader, v: VehState): VehState {
  v.x = r.f32(); v.y = r.f32(); v.z = r.f32(); v.yaw = r.f32(); v.pitch = r.f32(); v.roll = r.f32(); v.vx = r.f32(); v.vy = r.f32(); v.vz = r.f32(); v.yawRate = r.f32();
  v.steer = r.f32(); v.rpm = r.f32(); v.gear = r.i8(); v.shiftT = r.f32(); v.flags = r.u16(); v.hp = r.f32(); v.slipF = r.f32(); v.slipR = r.f32(); v.ax = r.f32(); v.ay = r.f32(); v.throttle = r.f32();
  return v;
}

export function decodeSnapshot(buf: ArrayBuffer | Uint8Array): Snapshot {
  const r = new Reader(buf);
  r.u8();
  const s: Snapshot = {
    tick: r.u32(), ack: r.u32(), hours: r.f32(),
    weather: { cover: r.u8() / 255, rain: r.u8() / 255, fog: r.u8() / 255, snow: r.u8() / 255, wind: r.u8() / 255 },
    wanted: r.u8(), money: r.i32(), ammo: r.u16(), weapon: r.u8(),
    me: readChar(r, newChar(0, 0, 0)), myVeh: r.u16(), mySeat: r.u8(), veh: null, players: [], vehicles: [], npcs: [],
  };
  if (r.u8()) s.veh = readVeh(r, newVeh(0, 0, 0, 0));
  const ox = s.me.x, oz = s.me.z;
  const np = r.u8();
  for (let i = 0; i < np; i++) {
    s.players.push({ id: r.u16(), x: r.f32(), y: r.f32(), z: r.f32(), yaw: r.i16() / ANG, vx: r.i8() / 4, vz: r.i8() / 4, flags: r.u8(), mode: r.u8(), hp: r.u8(), veh: r.u16(), seat: r.u8(), pitch: r.i8() / 80, anim: r.u8(), wanted: r.u8() });
  }
  const nv = r.u16();
  for (let i = 0; i < nv; i++) {
    s.vehicles.push({ id: r.u16(), spec: r.u8(), color: r.u8(), x: ox + r.i16() * 0.02, y: r.i16() * 0.05, z: oz + r.i16() * 0.02, yaw: r.i16() / ANG, pitch: r.i8() / 200, roll: r.i8() / 200, speed: r.i16() * 0.01, steer: r.i8() / 127, rpm: r.u8() / 255, flags: r.u16(), hp: r.u8() / 255, slip: r.u8() / 255, driver: r.u16() });
  }
  const nn = r.u16();
  for (let i = 0; i < nn; i++) {
    s.npcs.push({ id: r.u16(), x: ox + r.i16() * 0.02, y: r.i16() * 0.05, z: oz + r.i16() * 0.02, yaw: (r.u8() / 256) * Math.PI * 2 - Math.PI, state: r.u8(), look: r.u16(), speed: r.u8() / 20, kind: r.u8() });
  }
  return s;
}
export { ANG };
