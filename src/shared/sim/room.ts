// Authoritative game room: owns all dynamic state, steps the simulation and produces per-player snapshots.
// Transport-agnostic – runs in Node (WebSocket server) and in the browser (offline / loopback mode).
import { Rng, clamp, dist2 } from '../math';
import type { World } from '../world/world';
import { ANG, Command, PROTOCOL_VERSION, Pkt, PlayerInfo, Profile, ServerMsg, SNAPSHOT_HZ, Writer, levelForXp, packAppearance, writeChar, writeVeh, LobbyInfo } from '../net/protocol';
import { BTN, CF, CHAR_RADIUS, CharMode, CharState, DT, InputCmd, TICK_RATE, VF, VehState, VehicleSpec, emptyInput, newChar, newVeh, vehicleSpec } from './types';
import { DynCircle, charEvents, knockDown, stepCharacter } from './character';
import { VehInput, bodyCircles, collideVehicles, damageVehicle, stepVehicle, vehEvents } from './vehicle';
import { Traffic, TrafficAI } from './traffic';
import { Peds } from './peds';
import { Police } from './police';
import { Missions, MissionState } from './missions';
import { rayVsCollider, Collider } from '../world/colliders';

export interface RoomPlayer {
  id: number;
  name: string;
  accountId: string;
  look: number;
  profile: Profile;
  char: CharState;
  veh: number;
  seat: number;
  inputs: InputCmd[];
  last: InputCmd;
  ack: number;
  wanted: number;
  heat: number;
  /** seconds since a cop last saw the player */
  unseen: number;
  ammo: number;
  weapon: number;
  meleeHitT: number;
  respawnT: number;
  lastHurtT: number;
  mission: MissionState | null;
  connected: boolean;
  /** tick when the connection dropped (for the reconnect grace period) */
  dcTick: number;
  chatTimes: number[];
  kmAcc: number;
  dirty: boolean;
  send: (msg: ServerMsg | ArrayBuffer) => void;
}
export interface RoomVehicle {
  id: number;
  spec: VehicleSpec;
  st: VehState;
  color: number;
  /** player id of the driver (0 = none) */
  driver: number;
  passengers: number[];
  ai: TrafficAI | null;
  owner: number;
  /** asleep: no physics until touched */
  parked: boolean;
  spot: number;
  police: boolean;
  inp: VehInput;
  idleT: number;
  /** burning wreck countdown */
  fireT: number;
  cargo?: string;
}
export interface RoomNpc {
  id: number;
  /** 0 pedestrian, 1 police officer */
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  /** 0 idle, 1 walk, 2 run, 3 knocked, 4 dead, 5 aim, 6 cower */
  state: number;
  stateT: number;
  look: number;
  speed: number;
  hp: number;
  edge: number;
  dir: number;
  s: number;
  side: number;
  target: number;
  fireT: number;
  fleeX: number;
  fleeZ: number;
}

export interface RoomOptions {
  code: string;
  name: string;
  private: boolean;
  maxPlayers: number;
  seed?: number;
  /** called whenever a profile should be persisted */
  saveProfile?: (accountId: string, profile: Profile) => void;
}

export const INTEREST_VEH = 300;
export const INTEREST_NPC = 150;
const RESPAWN_DELAY = 4.5;
export const HOSPITAL = { x: 262, z: -196 };
const PAINTS = 16;

export class GameRoom {
  tick = 0;
  time = 0;
  hours = 9.5;
  weather = { cover: 0.3, rain: 0, fog: 0, snow: 0, wind: 0.25 };
  private weatherTarget = { cover: 0.3, rain: 0, fog: 0, snow: 0, wind: 0.25 };
  private weatherT = 0;
  players = new Map<number, RoomPlayer>();
  vehicles = new Map<number, RoomVehicle>();
  npcs = new Map<number, RoomNpc>();
  rng: Rng;
  traffic: Traffic;
  peds: Peds;
  police: Police;
  missions: Missions;
  private nextPlayer = 1;
  private nextVeh = 1;
  private nextNpc = 1;
  private w = new Writer(8192);
  private dyn: DynCircle[] = [];
  private circ: number[] = [];
  private tmpCol: Collider[] = [];

  constructor(readonly world: World, readonly opts: RoomOptions) {
    this.rng = new Rng(opts.seed ?? 12345);
    this.traffic = new Traffic(this);
    this.peds = new Peds(this);
    this.police = new Police(this);
    this.missions = new Missions(this);
  }

  get info(): LobbyInfo {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return { code: this.opts.code, name: this.opts.name, players: n, max: this.opts.maxPlayers, private: this.opts.private };
  }
  get playerCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // ------------------------------------------------------------ players
  addPlayer(accountId: string, profile: Profile, send: RoomPlayer['send']): RoomPlayer {
    // reconnect: take over the existing avatar of this account
    for (const p of this.players.values()) {
      if (p.accountId === accountId && !p.connected) {
        p.connected = true;
        p.send = send;
        p.inputs.length = 0;
        this.welcome(p);
        this.broadcast({ t: 'chat', from: 0, name: '', text: `${p.name} ist wieder verbunden.`, sys: true }, p.id);
        return p;
      }
    }
    const id = this.nextPlayer++;
    const sp = this.spawnPoint(id);
    const p: RoomPlayer = {
      id, name: profile.name, accountId, look: packAppearance(profile.appearance), profile,
      char: newChar(sp.x, this.world.groundAt(sp.x, sp.z), sp.z, sp.yaw), veh: 0, seat: 0,
      inputs: [], last: emptyInput(), ack: 0, wanted: 0, heat: 0, unseen: 99, ammo: 48, weapon: 1, meleeHitT: 0, respawnT: 0, lastHurtT: -99,
      mission: null, connected: true, dcTick: 0, chatTimes: [], kmAcc: 0, dirty: false, send,
    };
    this.players.set(id, p);
    this.welcome(p);
    this.broadcast({ t: 'join', p: this.playerInfo(p) }, id);
    this.broadcast({ t: 'chat', from: 0, name: '', text: `${p.name} ist der Lobby beigetreten.`, sys: true }, id);
    return p;
  }
  private welcome(p: RoomPlayer): void {
    p.send({ t: 'welcome', id: p.id, protocol: PROTOCOL_VERSION, tick: this.tick, lobby: this.info, profile: p.profile, players: [...this.players.values()].filter((o) => o.connected).map((o) => this.playerInfo(o)), secrets: p.profile.secrets });
    this.missions.sync(p);
  }
  playerInfo(p: RoomPlayer): PlayerInfo {
    return { id: p.id, name: p.name, look: p.look, level: levelForXp(p.profile.xp), account: p.accountId };
  }
  /** Connection lost: keep the avatar for a grace period so the player can reconnect. */
  disconnectPlayer(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    p.dcTick = this.tick;
    p.send = () => {};
    this.save(p);
    this.broadcast({ t: 'chat', from: 0, name: '', text: `${p.name} hat die Verbindung verloren.`, sys: true });
  }
  removePlayer(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    this.leaveVehicle(p, true);
    this.save(p);
    this.players.delete(id);
    this.broadcast({ t: 'leave', id });
  }
  save(p: RoomPlayer): void {
    p.dirty = false;
    this.opts.saveProfile?.(p.accountId, p.profile);
  }
  spawnPoint(seed: number): { x: number; z: number; yaw: number } {
    const sp = this.world.poi('spawn');
    const a = (seed * 2.399) % (Math.PI * 2);
    return { x: sp.x + Math.cos(a) * 3.2, z: sp.z + Math.sin(a) * 3.2 - 6, yaw: Math.PI };
  }
  broadcast(msg: ServerMsg, except = 0): void {
    for (const p of this.players.values()) if (p.id !== except && p.connected) p.send(msg);
  }
  /** Send to players within radius of a point. */
  broadcastNear(msg: ServerMsg, x: number, z: number, radius: number): void {
    for (const p of this.players.values()) if (p.connected && dist2(p.char.x, p.char.z, x, z) < radius) p.send(msg);
  }
  toast(p: RoomPlayer, text: string, kind: 'info' | 'good' | 'bad' | 'money' = 'info'): void {
    p.send({ t: 'toast', text, kind });
  }
  addMoney(p: RoomPlayer, amount: number, reason?: string): void {
    p.profile.money = Math.max(0, Math.round(p.profile.money + amount));
    p.dirty = true;
    if (reason) this.toast(p, `${amount >= 0 ? '+' : '−'} CHF ${Math.abs(Math.round(amount)).toLocaleString('de-CH')} · ${reason}`, amount >= 0 ? 'money' : 'bad');
  }
  addXp(p: RoomPlayer, xp: number): void {
    const before = levelForXp(p.profile.xp);
    p.profile.xp += Math.round(xp);
    const after = levelForXp(p.profile.xp);
    p.dirty = true;
    if (after > before) {
      this.toast(p, `Level ${after} erreicht`, 'good');
      this.broadcast({ t: 'join', p: this.playerInfo(p) });
    }
  }
  syncProfile(p: RoomPlayer): void {
    p.send({ t: 'profile', profile: p.profile });
  }

  // ------------------------------------------------------------ input / commands
  handleInputs(id: number, cmds: InputCmd[]): void {
    const p = this.players.get(id);
    if (!p) return;
    for (const c of cmds) {
      if (c.seq <= p.ack || (p.inputs.length && c.seq <= p.inputs[p.inputs.length - 1].seq)) continue;
      if (!Number.isFinite(c.mx + c.mz + c.yaw + c.pitch)) continue;
      c.mx = clamp(c.mx, -1, 1);
      c.mz = clamp(c.mz, -1, 1);
      c.pitch = clamp(c.pitch, -1.5, 1.5);
      p.inputs.push(c);
    }
    // a flood of inputs must not let a client run ahead of real time
    if (p.inputs.length > 40) p.inputs.splice(0, p.inputs.length - 12);
  }
  handleCommand(id: number, c: Command): void {
    const p = this.players.get(id);
    if (!p || typeof c !== 'object' || !c) return;
    switch (c.k) {
      case 'use': this.use(p); break;
      case 'chat': this.chat(p, String(c.text ?? '')); break;
      case 'respawn': if (p.char.mode === CharMode.Dead && p.respawnT <= 1.5) this.respawn(p); break;
      case 'toggle': {
        const v = this.vehicles.get(p.veh);
        if (v && v.driver === p.id) {
          if (c.what === 'lights') v.st.flags ^= VF.LIGHTS;
          else if (c.what === 'siren' && v.police) v.st.flags ^= VF.SIREN;
        }
        break;
      }
      case 'mission': this.missions.command(p, c.op, c.id); break;
      case 'buy': this.missions.buy(p, c.item, c.id ?? -1); break;
      case 'spawnOwned': this.missions.spawnOwned(p, c.spec | 0); break;
      case 'weapon': p.weapon = c.slot === 1 ? 1 : 0; break;
    }
  }
  private chat(p: RoomPlayer, text: string): void {
    text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const now = this.time;
    p.chatTimes = p.chatTimes.filter((t) => now - t < 10);
    if (p.chatTimes.length >= 6) {
      this.toast(p, 'Chat: bitte etwas langsamer.', 'bad');
      return;
    }
    p.chatTimes.push(now);
    this.broadcast({ t: 'chat', from: p.id, name: p.name, text });
  }

  // ------------------------------------------------------------ vehicles
  spawnVehicle(specId: number, x: number, z: number, yaw: number, color = -1): RoomVehicle {
    const spec = vehicleSpec(specId);
    const y = this.world.groundAt(x, z) + spec.ride;
    const v: RoomVehicle = {
      id: this.nextVeh++, spec, st: newVeh(x, y, z, yaw, spec.hp), color: color >= 0 ? color : this.rng.int(0, PAINTS - 1), driver: 0, passengers: [], ai: null, owner: 0,
      parked: false, spot: -1, police: spec.cls === 'police', inp: { steer: 0, throttle: 0, handbrake: false }, idleT: 0, fireT: 0,
    };
    if (this.nextVeh > 60000) this.nextVeh = 1;
    this.vehicles.set(v.id, v);
    return v;
  }
  removeVehicle(v: RoomVehicle): void {
    for (const pid of [v.driver, ...v.passengers]) {
      const p = this.players.get(pid);
      if (p) this.leaveVehicle(p, true);
    }
    this.vehicles.delete(v.id);
  }
  private use(p: RoomPlayer): void {
    if (p.char.mode === CharMode.Dead || p.char.mode === CharMode.Knocked) return;
    if (p.veh) {
      this.leaveVehicle(p, false);
      return;
    }
    if (this.missions.interact(p)) return;
    // nearest vehicle
    let best: RoomVehicle | null = null, bd = 3.4;
    for (const v of this.vehicles.values()) {
      if (Math.abs(v.st.y - p.char.y) > 3) continue;
      const d = this.distToVehicle(v, p.char.x, p.char.z);
      if (d < bd && !(v.st.flags & VF.WATER)) { bd = d; best = v; }
    }
    if (!best) return;
    const v = best;
    if (v.driver && this.players.has(v.driver)) {
      if (v.passengers.length >= v.spec.seats - 1) return;
      v.passengers.push(p.id);
      p.seat = v.passengers.length;
    } else {
      if (v.ai) {
        // car-jacking an NPC
        this.peds.spawnFleeing(v.st.x - Math.cos(v.st.yaw) * (v.spec.width / 2 + 0.8), v.st.z + Math.sin(v.st.yaw) * (v.spec.width / 2 + 0.8), p.char.x, p.char.z);
        v.ai = null;
        this.police.crime(p, v.police ? 3 : 1.2, v.police ? 'Polizeifahrzeug gestohlen' : 'Fahrzeugdiebstahl');
      } else if (v.owner === 0 && v.spot >= 0 && !v.police) {
        // stealing a parked car is only noticed some of the time
        if (this.rng.chance(0.3)) this.police.crime(p, 0.7, 'Fahrzeugdiebstahl');
      } else if (v.police && v.owner === 0) this.police.crime(p, 2.5, 'Polizeifahrzeug gestohlen');
      v.driver = p.id;
      p.seat = 0;
      v.parked = false;
      v.spot = -1;
      v.st.flags |= VF.ENGINE;
      if (this.hours > 20.2 || this.hours < 6.6 || this.weather.rain > 0.4) v.st.flags |= VF.LIGHTS;
    }
    p.veh = v.id;
    p.char.mode = CharMode.InVehicle;
    p.char.vx = p.char.vy = p.char.vz = 0;
    p.inputs.length = 0;
    this.missions.onEnterVehicle(p, v);
  }
  distToVehicle(v: RoomVehicle, x: number, z: number): number {
    const dx = x - v.st.x, dz = z - v.st.z;
    const s = Math.sin(v.st.yaw), c = Math.cos(v.st.yaw);
    const lf = dx * s + dz * c, ll = dx * c - dz * s;
    const ex = Math.max(0, Math.abs(ll) - v.spec.width / 2), ez = Math.max(0, Math.abs(lf) - v.spec.length / 2);
    return Math.sqrt(ex * ex + ez * ez);
  }
  leaveVehicle(p: RoomPlayer, silent: boolean): void {
    const v = this.vehicles.get(p.veh);
    p.veh = 0;
    if (p.char.mode === CharMode.InVehicle) p.char.mode = CharMode.Normal;
    if (!v) return;
    const st = v.st;
    if (v.driver === p.id) {
      v.driver = 0;
      v.inp.throttle = 0; v.inp.steer = 0; v.inp.handbrake = true;
      v.idleT = 0;
      st.flags &= ~(VF.SIREN | VF.HORN);
      // first passenger slides over? keep it simple: passengers stay passengers
    } else v.passengers = v.passengers.filter((x) => x !== p.id);
    // exit position: driver's side first
    const lx = Math.cos(st.yaw), lz = -Math.sin(st.yaw), fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
    const side = v.spec.width / 2 + 0.75;
    const cands = [[lx * side, lz * side], [-lx * side, -lz * side], [-fx * (v.spec.length / 2 + 0.9), -fz * (v.spec.length / 2 + 0.9)], [fx * (v.spec.length / 2 + 0.9), fz * (v.spec.length / 2 + 0.9)]];
    if (p.seat > 0) cands.unshift(cands.splice(1, 1)[0]);
    let ex = st.x + cands[0][0], ez = st.z + cands[0][1];
    for (const c of cands) {
      const x = st.x + c[0], z = st.z + c[1];
      if (this.isFree(x, z, st.y - v.spec.ride)) { ex = x; ez = z; break; }
    }
    const ch = p.char;
    ch.x = ex; ch.z = ez;
    ch.y = Math.max(this.world.groundAt(ex, ez, st.y + 1), st.y - v.spec.ride - 0.4);
    ch.yaw = st.yaw;
    ch.flags = 0;
    const sp = Math.hypot(st.vx, st.vz);
    ch.vx = st.vx * 0.6; ch.vz = st.vz * 0.6; ch.vy = 0;
    if (!silent && sp > 8) {
      knockDown(ch, st.vx * 0.7, 2, st.vz * 0.7, 1.4);
      this.hurtPlayer(p, (sp - 8) * 2.2, 'Sturz');
    }
    p.seat = 0;
    p.inputs.length = 0;
  }
  isFree(x: number, z: number, y: number): boolean {
    this.world.colliders.query(x, z, CHAR_RADIUS + 0.2, this.tmpCol);
    for (const c of this.tmpCol) {
      if (c.y1 < y + 0.4 || c.y0 > y + 1.7) continue;
      if (c.kind === 1) {
        if (dist2(x, z, c.x, c.z) < c.hx + CHAR_RADIUS) return false;
      } else {
        const dx = x - c.x, dz = z - c.z;
        const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
        if (Math.abs(lx) < c.hx + CHAR_RADIUS && Math.abs(lz) < c.hz + CHAR_RADIUS) return false;
      }
    }
    return Math.abs(this.world.groundAt(x, z, y + 1) - y) < 1.6;
  }

  // ------------------------------------------------------------ damage
  hurtPlayer(p: RoomPlayer, dmg: number, by?: string): void {
    const c = p.char;
    if (c.mode === CharMode.Dead || dmg <= 0) return;
    c.hp -= dmg;
    p.lastHurtT = this.time;
    if (c.hp <= 0) this.killPlayer(p, by, false);
  }
  killPlayer(p: RoomPlayer, by: string | undefined, busted: boolean): void {
    const c = p.char;
    if (c.mode === CharMode.Dead) return;
    this.leaveVehicle(p, true);
    c.hp = 0;
    c.mode = CharMode.Dead;
    p.respawnT = RESPAWN_DELAY;
    const fee = busted ? Math.min(p.profile.money, 250 + p.wanted * 350) : Math.min(p.profile.money, Math.max(100, Math.round(p.profile.money * 0.05)));
    if (busted) p.profile.stats.busted++;
    else p.profile.stats.wasted++;
    p.profile.money -= fee;
    p.dirty = true;
    p.send({ t: 'wasted', by, busted, fee });
    this.missions.onPlayerDown(p);
    this.police.clear(p);
  }
  respawn(p: RoomPlayer): void {
    const c = p.char;
    const x = HOSPITAL.x + ((p.id * 37) % 5) - 2, z = HOSPITAL.z + 4;
    Object.assign(c, newChar(x, this.world.groundAt(x, z), z, Math.PI / 2));
    p.respawnT = 0;
    p.inputs.length = 0;
    this.syncProfile(p);
  }

  // ------------------------------------------------------------ combat
  private fire(p: RoomPlayer, inp: InputCmd): void {
    const c = p.char;
    c.fireT = 0.19;
    p.ammo--;
    const cp = Math.cos(inp.pitch);
    const dx = Math.sin(inp.yaw) * cp, dy = Math.sin(inp.pitch), dz = Math.cos(inp.yaw) * cp;
    const ox = c.x + Math.sin(c.yaw) * 0.4, oy = c.y + ((c.flags & CF.CROUCH) ? 1.05 : 1.48), oz = c.z + Math.cos(c.yaw) * 0.4;
    const R = 140;
    let best = R, hit = 0, hitNpc: RoomNpc | null = null, hitVeh: RoomVehicle | null = null, hitPl: RoomPlayer | null = null;
    // terrain
    for (let t = 2; t < R; t += 2.5) {
      if (this.world.groundAt(ox + dx * t, oz + dz * t, oy + dy * t + 1) > oy + dy * t) { best = t; hit = 1; break; }
    }
    // static colliders along the ray
    const hl = Math.hypot(dx, dz);
    if (hl > 0.01) {
      const ux = dx / hl, uz = dz / hl;
      const steps = Math.ceil((best * hl) / 20);
      for (let i = 0; i < steps; i++) {
        const mx = ox + ux * (i * 20 + 10), mz = oz + uz * (i * 20 + 10);
        this.world.colliders.query(mx, mz, 12, this.tmpCol);
        for (const col of this.tmpCol) {
          const t2 = rayVsCollider(ox, oz, ux, uz, best * hl, col);
          if (t2 < 0) continue;
          const t = t2 / hl, y = oy + dy * t;
          if (y >= col.y0 && y <= col.y1 && t < best) { best = t; hit = 1; }
        }
      }
    }
    const sphere = (px: number, py: number, pz: number, r: number): number => {
      const fx = ox - px, fy = oy - py, fz = oz - pz;
      const b = fx * dx + fy * dy + fz * dz, cc = fx * fx + fy * fy + fz * fz - r * r;
      const disc = b * b - cc;
      if (disc < 0) return -1;
      const t = -b - Math.sqrt(disc);
      return t > 0 ? t : -1;
    };
    for (const n of this.npcs.values()) {
      if (n.state === 4 || dist2(n.x, n.z, ox, oz) > R) continue;
      for (const h of [0.5, 1.1, 1.55]) {
        const t = sphere(n.x, n.y + h, n.z, 0.38);
        if (t > 0 && t < best) { best = t; hit = 2; hitNpc = n; hitVeh = null; hitPl = null; }
      }
    }
    for (const v of this.vehicles.values()) {
      if (v.id === p.veh || dist2(v.st.x, v.st.z, ox, oz) > R) continue;
      const r = bodyCircles(v.spec, this.circ);
      for (const off of this.circ) {
        const t = sphere(v.st.x + Math.sin(v.st.yaw) * off, v.st.y + 0.45, v.st.z + Math.cos(v.st.yaw) * off, r);
        if (t > 0 && t < best) { best = t; hit = 3; hitVeh = v; hitNpc = null; hitPl = null; }
      }
    }
    for (const o of this.players.values()) {
      if (o === p || o.char.mode === CharMode.Dead || o.veh) continue;
      for (const h of [0.5, 1.1, 1.55]) {
        const t = sphere(o.char.x, o.char.y + h, o.char.z, 0.38);
        if (t > 0 && t < best) { best = t; hit = 4; hitPl = o; hitNpc = null; hitVeh = null; }
      }
    }
    const hx = ox + dx * best, hy = oy + dy * best, hz = oz + dz * best;
    if (hitNpc) this.peds.damage(hitNpc, 38, p, dx, dz);
    else if (hitVeh) {
      this.wake(hitVeh);
      if (damageVehicle(hitVeh.st, 45)) this.onWreck(hitVeh, p);
      if (hitVeh.ai) hitVeh.ai.panic = 8;
      if (hitVeh.police) this.police.crime(p, 1.5, 'Angriff auf die Polizei');
    } else if (hitPl) {
      // friendly fire between players is limited so co-op stays fun
      this.hurtPlayer(hitPl, 8, p.name);
    }
    this.police.gunfire(p, ox, oz);
    this.peds.scare(ox, oz, 55, p);
    this.broadcastNear({ t: 'shot', by: p.id, x: ox, y: oy, z: oz, hx, hy, hz, hit }, ox, oz, 260);
  }
  private melee(p: RoomPlayer): void {
    const c = p.char;
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    let done = false;
    for (const n of this.npcs.values()) {
      if (n.state === 4) continue;
      const dx = n.x - c.x, dz = n.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.7 && Math.abs(n.y - c.y) < 1.5 && (dx * fx + dz * fz) / (d + 0.01) > 0.3) {
        this.peds.damage(n, 30, p, fx, fz);
        done = true;
        break;
      }
    }
    if (!done) {
      for (const o of this.players.values()) {
        if (o === p || o.veh || o.char.mode !== CharMode.Normal) continue;
        const dx = o.char.x - c.x, dz = o.char.z - c.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.6 && (dx * fx + dz * fz) / (d + 0.01) > 0.3) {
          knockDown(o.char, fx * 3.2, 2.2, fz * 3.2, 1.2);
          this.hurtPlayer(o, 4, p.name);
          done = true;
          break;
        }
      }
    }
    if (done) this.broadcastNear({ t: 'fx', kind: 'punch', x: c.x + fx, y: c.y + 1.3, z: c.z + fz }, c.x, c.z, 60);
  }
  onWreck(v: RoomVehicle, by: RoomPlayer | null): void {
    v.fireT = 7;
    v.ai = null;
    if (by && v.police) this.police.crime(by, 2, 'Polizeifahrzeug zerstört');
  }
  wake(v: RoomVehicle): void {
    v.parked = false;
    v.idleT = 0;
  }

  // ------------------------------------------------------------ simulation step
  step(): void {
    const world = this.world;
    this.tick++;
    this.time += DT;
    this.hours = (this.hours + DT / 120) % 24;
    this.updateWeather();
    const wetGrip = 1 - this.weather.rain * 0.22 - this.weather.snow * 0.35;

    // --- players
    for (const p of this.players.values()) {
      const c = p.char;
      if (!p.connected) {
        // 90 s reconnect grace, then the avatar leaves
        if (this.tick - p.dcTick > 90 * TICK_RATE) { this.removePlayer(p.id); continue; }
      }
      let n = p.inputs.length > 5 ? 2 : 1;
      while (n-- > 0) {
        let inp = p.inputs.shift();
        if (inp) { p.last = inp; p.ack = inp.seq; }
        else {
          inp = p.last;
          if (!p.connected) inp = emptyInput();
          n = 0;
        }
        this.stepPlayer(p, inp, wetGrip);
      }
      // timers
      if (c.mode === CharMode.Dead) {
        p.respawnT -= DT;
        if (p.respawnT <= 0) this.respawn(p);
      } else if (this.time - p.lastHurtT > 9 && c.hp < 70 && c.hp > 0) c.hp = Math.min(70, c.hp + DT * 3);
      if (p.meleeHitT > 0) {
        p.meleeHitT -= DT;
        if (p.meleeHitT <= 0) this.melee(p);
      }
      if (p.dirty && this.tick % (TICK_RATE * 20) === p.id % (TICK_RATE * 20)) this.save(p);
      if (this.tick % TICK_RATE === 0) p.profile.stats.playSeconds++;
    }

    // --- AI + unattended vehicles
    this.traffic.update(wetGrip);
    for (const v of this.vehicles.values()) {
      if (v.driver && this.players.has(v.driver)) continue;
      if (v.parked) continue;
      const st = v.st;
      if (!v.ai) {
        v.inp.throttle = 0; v.inp.steer = 0; v.inp.handbrake = true;
        v.idleT += DT;
        // settle to sleep once stopped
        if (v.idleT > 2 && Math.abs(st.vx) + Math.abs(st.vz) + Math.abs(st.vy) < 0.05) { v.parked = true; st.vx = st.vz = st.vy = st.yawRate = 0; continue; }
      }
      stepVehicle(st, v.spec, v.inp, world, DT, wetGrip);
      this.afterVehicleStep(v, null);
    }
    // --- wrecks burn out
    for (const v of this.vehicles.values()) {
      if (v.fireT > 0) {
        v.fireT -= DT;
        if (v.fireT <= 0) {
          this.broadcastNear({ t: 'fx', kind: 'explode', x: v.st.x, y: v.st.y, z: v.st.z }, v.st.x, v.st.z, 400);
          for (const p of this.players.values()) {
            const d = dist2(p.char.x, p.char.z, v.st.x, v.st.z);
            if (d < 9 && p.char.mode !== CharMode.Dead) {
              if (p.veh === v.id) this.leaveVehicle(p, true);
              this.hurtPlayer(p, (9 - d) * 14, 'Explosion');
              knockDown(p.char, ((p.char.x - v.st.x) / (d + 0.1)) * 6, 5, ((p.char.z - v.st.z) / (d + 0.1)) * 6, 2);
            }
          }
          this.peds.scare(v.st.x, v.st.z, 60, null);
          v.fireT = -40; // despawn timer
        }
      } else if (v.fireT < 0) {
        v.fireT += DT;
        if (v.fireT >= 0) this.removeVehicle(v);
      }
    }
    this.collideAll();
    this.peds.update();
    this.police.update();
    this.missions.update();

    if (this.tick % (TICK_RATE / SNAPSHOT_HZ) === 0) {
      for (const p of this.players.values()) if (p.connected) p.send(this.snapshot(p));
    }
  }

  private stepPlayer(p: RoomPlayer, inp: InputCmd, wetGrip: number): void {
    const c = p.char;
    const v = p.veh ? this.vehicles.get(p.veh) : undefined;
    if (v && c.mode === CharMode.InVehicle) {
      if (v.driver === p.id) {
        v.inp.steer = inp.mx;
        v.inp.throttle = inp.mz;
        v.inp.handbrake = (inp.buttons & BTN.HANDBRAKE) !== 0;
        if (inp.buttons & BTN.HORN) v.st.flags |= VF.HORN;
        else v.st.flags &= ~VF.HORN;
        const ox = v.st.x, oz = v.st.z;
        stepVehicle(v.st, v.spec, v.inp, this.world, DT, wetGrip);
        this.afterVehicleStep(v, p);
        p.kmAcc += Math.hypot(v.st.x - ox, v.st.z - oz);
        if (p.kmAcc > 100) { p.profile.stats.km += p.kmAcc / 1000; p.kmAcc = 0; p.dirty = true; }
        if (v.st.flags & VF.WATER && v.st.y < this.world.waterLevel - 0.3) this.leaveVehicle(p, true);
      }
      c.x = v.st.x; c.y = v.st.y - v.spec.ride; c.z = v.st.z; c.yaw = v.st.yaw;
      c.prevButtons = inp.buttons;
      return;
    }
    if (p.veh && !v) { p.veh = 0; c.mode = CharMode.Normal; }
    // nearby vehicles block the character
    const dyn = this.dyn;
    dyn.length = 0;
    for (const o of this.vehicles.values()) {
      const dx = o.st.x - c.x, dz = o.st.z - c.z;
      if (dx * dx + dz * dz > 64) continue;
      const r = bodyCircles(o.spec, this.circ);
      for (const off of this.circ) dyn.push({ x: o.st.x + Math.sin(o.st.yaw) * off, z: o.st.z + Math.cos(o.st.yaw) * off, r: r * 0.92, y0: o.st.y - o.spec.ride, y1: o.st.y - o.spec.ride + o.spec.height });
    }
    stepCharacter(c, inp, this.world, DT, dyn);
    if (charEvents.meleeStart) p.meleeHitT = 0.2;
    if (c.mode === CharMode.Normal && (inp.buttons & BTN.FIRE) && (c.flags & CF.AIM) && p.weapon === 1 && c.fireT <= 0 && p.ammo > 0) this.fire(p, inp);
    if (c.hp <= 0 && c.mode === CharMode.Dead && p.respawnT <= 0) {
      // died inside the character step (fall damage)
      c.mode = CharMode.Normal;
      c.hp = 0.01;
      this.killPlayer(p, 'Sturz', false);
    }
  }

  private afterVehicleStep(v: RoomVehicle, driver: RoomPlayer | null): void {
    if (vehEvents.impact > 3.2) {
      const dmg = (vehEvents.impact - 3.2) * 16;
      if (damageVehicle(v.st, dmg)) this.onWreck(v, driver);
      if (vehEvents.impact > 6) this.broadcastNear({ t: 'fx', kind: 'crash', x: v.st.x, y: v.st.y, z: v.st.z, a: Math.min(1, vehEvents.impact / 22) }, v.st.x, v.st.z, 160);
      if (driver && vehEvents.impact > 14) this.hurtPlayer(driver, (vehEvents.impact - 14) * 2.4, 'Unfall');
      if (driver) this.missions.onCrash(driver, vehEvents.impact);
    }
    if (vehEvents.brokeProp >= 0) this.broadcastNear({ t: 'fx', kind: 'prop', x: v.st.x, y: v.st.y, z: v.st.z, a: vehEvents.brokeProp }, v.st.x, v.st.z, 200);
  }

  /** Vehicle ↔ vehicle and vehicle ↔ people collisions. */
  private collideAll(): void {
    const list: RoomVehicle[] = [];
    for (const v of this.vehicles.values()) list.push(v);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const moving = !a.parked;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!moving && b.parked) continue;
        if (Math.abs(a.st.x - b.st.x) > 9 || Math.abs(a.st.z - b.st.z) > 9) continue;
        const imp = collideVehicles(a.st, a.spec, b.st, b.spec);
        if (imp > 0) {
          this.wake(a);
          this.wake(b);
          if (imp > 2.5) {
            const dmg = (imp - 2.5) * 13;
            const pa = this.players.get(a.driver) ?? null, pb = this.players.get(b.driver) ?? null;
            if (damageVehicle(a.st, dmg)) this.onWreck(a, pb);
            if (damageVehicle(b.st, dmg)) this.onWreck(b, pa);
            if (imp > 5) this.broadcastNear({ t: 'fx', kind: 'crash', x: (a.st.x + b.st.x) / 2, y: a.st.y, z: (a.st.z + b.st.z) / 2, a: Math.min(1, imp / 22) }, a.st.x, a.st.z, 160);
            if (pa) { this.missions.onCrash(pa, imp); if (b.police) this.police.crime(pa, 1.2, 'Polizeifahrzeug gerammt'); else if (b.ai && imp > 6) this.police.crime(pa, 0.25, 'Verkehrsunfall'); }
            if (pb) { this.missions.onCrash(pb, imp); if (a.police) this.police.crime(pb, 1.2, 'Polizeifahrzeug gerammt'); else if (a.ai && imp > 6) this.police.crime(pb, 0.25, 'Verkehrsunfall'); }
            if (a.ai) a.ai.panic = Math.max(a.ai.panic, 2);
            if (b.ai) b.ai.panic = Math.max(b.ai.panic, 2);
          }
        }
      }
      if (!moving) continue;
      // people
      const sp = Math.hypot(a.st.vx, a.st.vz);
      if (sp < 2.2) continue;
      const r = bodyCircles(a.spec, this.circ) * 0.95;
      const fx = Math.sin(a.st.yaw), fz = Math.cos(a.st.yaw);
      const drv = this.players.get(a.driver) ?? null;
      for (const p of this.players.values()) {
        if (p.veh || p.char.mode === CharMode.Dead || p.char.mode === CharMode.Knocked) continue;
        if (this.hitsBody(a, p.char.x, p.char.y, p.char.z, r, fx, fz)) {
          knockDown(p.char, a.st.vx * 0.9, 2.5 + sp * 0.12, a.st.vz * 0.9, 1.6);
          this.hurtPlayer(p, Math.max(0, sp - 3) * (drv ? 2.2 : 4.2), drv ? drv.name : 'Verkehr');
        }
      }
      for (const n of this.npcs.values()) {
        if (n.state === 4 || n.state === 3) continue;
        if (Math.abs(n.x - a.st.x) > 8 || Math.abs(n.z - a.st.z) > 8) continue;
        if (this.hitsBody(a, n.x, n.y, n.z, r, fx, fz)) this.peds.hitByVehicle(n, a, sp, drv);
      }
    }
  }
  private hitsBody(v: RoomVehicle, x: number, y: number, z: number, r: number, fx: number, fz: number): boolean {
    if (Math.abs(y - (v.st.y - v.spec.ride)) > 1.8) return false;
    for (const off of this.circ) {
      const dx = x - (v.st.x + fx * off), dz = z - (v.st.z + fz * off);
      if (dx * dx + dz * dz < (r + 0.3) * (r + 0.3)) return true;
    }
    return false;
  }

  private updateWeather(): void {
    this.weatherT -= DT;
    if (this.weatherT <= 0) {
      this.weatherT = this.rng.range(150, 420);
      const r = this.rng.next();
      const cold = this.hours < 6 || this.hours > 21;
      if (r < 0.5) this.weatherTarget = { cover: this.rng.range(0.05, 0.4), rain: 0, fog: 0, snow: 0, wind: this.rng.range(0.1, 0.4) };
      else if (r < 0.72) this.weatherTarget = { cover: this.rng.range(0.5, 0.85), rain: 0, fog: 0, snow: 0, wind: this.rng.range(0.2, 0.5) };
      else if (r < 0.86) this.weatherTarget = { cover: 0.95, rain: this.rng.range(0.35, 0.7), fog: 0.05, snow: 0, wind: this.rng.range(0.3, 0.6) };
      else if (r < 0.92) this.weatherTarget = { cover: 1, rain: 1, fog: 0.1, snow: 0, wind: 0.9 };
      else if (r < 0.97) this.weatherTarget = { cover: 0.6, rain: 0, fog: this.rng.range(0.4, 0.8), snow: 0, wind: 0.05 };
      else this.weatherTarget = { cover: 0.9, rain: 0, fog: 0.1, snow: cold ? 0.8 : 0.5, wind: 0.3 };
    }
    const k = DT / 25;
    const w = this.weather as Record<string, number>, t = this.weatherTarget as Record<string, number>;
    for (const key of ['cover', 'rain', 'fog', 'snow', 'wind']) w[key] += clamp(t[key] - w[key], -k, k);
  }
  setWeather(kind: 'clear' | 'rain' | 'storm' | 'fog' | 'snow' | 'cloudy', instant = false): void {
    const T = { clear: { cover: 0.15, rain: 0, fog: 0, snow: 0, wind: 0.2 }, cloudy: { cover: 0.8, rain: 0, fog: 0, snow: 0, wind: 0.4 }, rain: { cover: 0.95, rain: 0.6, fog: 0.05, snow: 0, wind: 0.5 }, storm: { cover: 1, rain: 1, fog: 0.1, snow: 0, wind: 0.9 }, fog: { cover: 0.6, rain: 0, fog: 0.7, snow: 0, wind: 0.05 }, snow: { cover: 0.9, rain: 0, fog: 0.1, snow: 0.8, wind: 0.3 } }[kind];
    this.weatherTarget = { ...T };
    this.weatherT = 600;
    if (instant) this.weather = { ...T };
  }

  // ------------------------------------------------------------ snapshot
  snapshot(p: RoomPlayer): ArrayBuffer {
    const w = this.w;
    w.reset();
    const c = p.char;
    w.u8(Pkt.Snapshot);
    w.u32(this.tick);
    w.u32(p.ack);
    w.f32(this.hours);
    w.u8(this.weather.cover * 255); w.u8(this.weather.rain * 255); w.u8(this.weather.fog * 255); w.u8(this.weather.snow * 255); w.u8(this.weather.wind * 255);
    w.u8(p.wanted);
    w.i32(p.profile.money);
    w.u16(p.ammo);
    w.u8(p.weapon);
    writeChar(w, c);
    w.u16(p.veh);
    w.u8(p.seat);
    const mine = p.veh ? this.vehicles.get(p.veh) : undefined;
    if (mine && mine.driver === p.id) { w.u8(1); writeVeh(w, mine.st); }
    else w.u8(0);
    // other players (always sent: few, and needed for the map)
    const others: RoomPlayer[] = [];
    for (const o of this.players.values()) if (o !== p && o.connected) others.push(o);
    w.u8(others.length);
    for (const o of others) {
      const oc = o.char;
      w.u16(o.id); w.f32(oc.x); w.f32(oc.y); w.f32(oc.z); w.i16(oc.yaw * ANG); w.i8(oc.vx * 4); w.i8(oc.vz * 4);
      w.u8(oc.flags); w.u8(oc.mode); w.u8(clamp(oc.hp, 0, 255)); w.u16(o.veh); w.u8(o.seat); w.i8(o.last.pitch * 80);
      w.u8((oc.meleeT > 0 ? 1 : 0) | (oc.fireT > 0.1 ? 2 : 0) | (o.weapon ? 4 : 0));
      w.u8(o.wanted);
    }
    // vehicles in interest range
    const R2 = INTEREST_VEH * INTEREST_VEH;
    let count = 0;
    const cntPos = w.o;
    w.u16(0);
    for (const v of this.vehicles.values()) {
      const st = v.st;
      const dx = st.x - c.x, dz = st.z - c.z;
      if (dx * dx + dz * dz > R2 || count >= 110) continue;
      const fwd = st.vx * Math.sin(st.yaw) + st.vz * Math.cos(st.yaw);
      w.u16(v.id); w.u8(v.spec.id); w.u8(v.color);
      w.i16(dx / 0.02); w.i16(st.y / 0.05); w.i16(dz / 0.02);
      w.i16(st.yaw * ANG); w.i8(st.pitch * 200); w.i8(st.roll * 200); w.i16(fwd * 100); w.i8((st.steer / v.spec.steerMax) * 127);
      w.u8(clamp(st.rpm / v.spec.redline, 0, 1) * 255);
      w.u16(st.flags | (v.fireT > 0 ? 0x8000 : 0) | (v.police ? 0x4000 : 0) | (v.ai ? 0x2000 : 0));
      w.u8(clamp(st.hp / v.spec.hp, 0, 1) * 255);
      w.u8(clamp(Math.max(st.slipF, st.slipR), 0, 1) * 255);
      w.u16(v.driver);
      count++;
    }
    w.dv.setUint16(cntPos, count, true);
    // npcs
    const N2 = INTEREST_NPC * INTEREST_NPC;
    count = 0;
    const nPos = w.o;
    w.u16(0);
    for (const n of this.npcs.values()) {
      const dx = n.x - c.x, dz = n.z - c.z;
      if (dx * dx + dz * dz > N2 || count >= 90) continue;
      w.u16(n.id); w.i16(dx / 0.02); w.i16(n.y / 0.05); w.i16(dz / 0.02);
      w.u8(((n.yaw + Math.PI) / (Math.PI * 2)) * 256); w.u8(n.state); w.u16(n.look); w.u8(clamp(n.speed * 20, 0, 255)); w.u8(n.kind);
      count++;
    }
    w.dv.setUint16(nPos, count, true);
    return w.done();
  }

  nextNpcId(): number {
    const id = this.nextNpc++;
    if (this.nextNpc > 60000) this.nextNpc = 1;
    return id;
  }
}
