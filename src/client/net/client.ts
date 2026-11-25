// Network client: transports (loopback room / WebSocket), client-side prediction with reconciliation for the
// local character or vehicle, and snapshot interpolation for everything else.
import { angleDiff, clamp, lerp } from '../../shared/math';
import type { World } from '../../shared/world/world';
import { ClientMsg, Command, MissionView, Pkt, PlayerInfo, Profile, Reader, ServerMsg, Snapshot, decodeInputs, decodeSnapshot, encodeInputs, newProfile, quantizeInput, LobbyInfo } from '../../shared/net/protocol';
import { BTN, CharMode, CharState, DT, InputCmd, VF, VehState, copyChar, copyVeh, newChar, newVeh, vehicleSpec } from '../../shared/sim/types';
import { DynCircle, charEvents, stepCharacter } from '../../shared/sim/character';
import { VehInput, bodyCircles, stepVehicle, vehEvents } from '../../shared/sim/vehicle';
import { GameRoom } from '../../shared/sim/room';

export interface Transport {
  send(data: ClientMsg | ArrayBuffer): void;
  onMessage: (data: ServerMsg | ArrayBuffer) => void;
  onClose: (reason: string) => void;
  update(dt: number): void;
  close(): void;
  readonly kind: 'local' | 'online';
}

/** Runs the authoritative room inside the browser (offline play). Optional artificial latency for testing. */
export class LoopbackTransport implements Transport {
  readonly kind = 'local';
  onMessage: Transport['onMessage'] = () => {};
  onClose: Transport['onClose'] = () => {};
  room: GameRoom;
  private acc = 0;
  private playerId = 0;
  private queue: { at: number; fn: () => void }[] = [];
  private now = 0;
  /** one-way latency in seconds, jitter and loss for netcode testing */
  lag = 0;
  jitter = 0;
  loss = 0;

  constructor(world: World, profile: Profile, private saveProfile: (p: Profile) => void) {
    this.room = new GameRoom(world, { code: 'LOKAL', name: 'Einzelspieler', private: true, maxPlayers: 1, seed: (Date.now() & 0xffff) + 7, saveProfile: (_id, p) => this.saveProfile(p) });
    const pl = this.room.addPlayer('local', profile, (m) => this.deliver(() => this.onMessage(m), m instanceof ArrayBuffer));
    this.playerId = pl.id;
  }
  private deliver(fn: () => void, unreliable: boolean): void {
    if (this.lag <= 0 && this.jitter <= 0) { this.queue.push({ at: this.now, fn }); return; }
    if (unreliable && Math.random() < this.loss) return;
    this.queue.push({ at: this.now + this.lag + Math.random() * this.jitter, fn });
  }
  send(data: ClientMsg | ArrayBuffer): void {
    const handle = () => {
      if (data instanceof ArrayBuffer) {
        const r = new Reader(data);
        if (r.u8() === Pkt.Input) this.room.handleInputs(this.playerId, decodeInputs(r));
      } else if (data.t === 'cmd') this.room.handleCommand(this.playerId, data.c);
      else if (data.t === 'ping') this.onMessage({ t: 'pong', c: data.c, s: this.room.tick });
      else if (data.t === 'appearance') {
        const p = this.room.players.get(this.playerId);
        if (p) { p.profile.appearance = data.a; this.room.save(p); }
      }
    };
    if (this.lag <= 0 && this.jitter <= 0) handle();
    else if (!(data instanceof ArrayBuffer) || Math.random() >= this.loss) this.queue.push({ at: this.now + this.lag + Math.random() * this.jitter, fn: handle });
  }
  update(dt: number): void {
    this.now += dt;
    this.acc = Math.min(this.acc + dt, DT * 5);
    while (this.acc >= DT) {
      this.room.step();
      this.acc -= DT;
    }
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.at <= this.now);
      this.queue = this.queue.filter((q) => q.at > this.now);
      due.sort((a, b) => a.at - b.at);
      for (const q of due) q.fn();
    }
  }
  close(): void {
    const p = this.room.players.get(this.playerId);
    if (p) this.room.save(p);
  }
}

export class WsTransport implements Transport {
  readonly kind = 'online';
  onMessage: Transport['onMessage'] = () => {};
  onClose: Transport['onClose'] = () => {};
  ws: WebSocket;
  private open = false;
  private pending: (string | ArrayBuffer)[] = [];
  constructor(url: string, onOpen?: () => void) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.open = true;
      for (const m of this.pending) this.ws.send(m);
      this.pending.length = 0;
      onOpen?.();
    };
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try { this.onMessage(JSON.parse(ev.data) as ServerMsg); } catch { /* ignore malformed */ }
      } else this.onMessage(ev.data as ArrayBuffer);
    };
    this.ws.onclose = (ev) => { this.open = false; this.onClose(ev.reason || 'Verbindung getrennt'); };
    this.ws.onerror = () => {};
  }
  send(data: ClientMsg | ArrayBuffer): void {
    const m = data instanceof ArrayBuffer ? data : JSON.stringify(data);
    if (this.open) this.ws.send(m);
    else if (!(data instanceof ArrayBuffer)) this.pending.push(m);
  }
  update(): void {}
  close(): void {
    this.ws.onclose = null;
    this.ws.close();
  }
}

// ---------------------------------------------------------------- interpolated remote entities
interface Sample { t: number; x: number; y: number; z: number; yaw: number }
export class Remote<T> {
  a: Sample = { t: 0, x: 0, y: 0, z: 0, yaw: 0 };
  b: Sample = { t: 0, x: 0, y: 0, z: 0, yaw: 0 };
  x = 0; y = 0; z = 0; yaw = 0;
  /** horizontal speed derived from the samples */
  speed = 0;
  vx = 0; vz = 0;
  seen = 0;
  fresh = true;
  constructor(public data: T) {}
  push(t: number, x: number, y: number, z: number, yaw: number): void {
    if (this.fresh) {
      this.a = { t: t - 0.05, x, y, z, yaw };
      this.b = { t, x, y, z, yaw };
      this.x = x; this.y = y; this.z = z; this.yaw = yaw;
      this.fresh = false;
      return;
    }
    if (t <= this.b.t) return;
    // teleports are not interpolated
    const jump = Math.abs(x - this.b.x) + Math.abs(z - this.b.z) > 25;
    this.a = jump ? { t: t - 0.05, x, y, z, yaw } : this.b;
    this.b = { t, x, y, z, yaw };
  }
  sample(rt: number): void {
    const a = this.a, b = this.b;
    const span = Math.max(1e-3, b.t - a.t);
    // interpolate, extrapolating at most 150 ms past the newest sample
    const k = clamp((rt - a.t) / span, 0, 1 + 0.15 / span);
    this.x = lerp(a.x, b.x, k); this.y = lerp(a.y, b.y, k); this.z = lerp(a.z, b.z, k);
    this.yaw = a.yaw + angleDiff(a.yaw, b.yaw) * Math.min(k, 1.2);
    this.vx = (b.x - a.x) / span; this.vz = (b.z - a.z) / span;
    this.speed = Math.hypot(this.vx, this.vz);
  }
}
import type { SnapNpc, SnapPlayer, SnapVehicle } from '../../shared/net/protocol';

export interface NetEvents {
  welcome?: (id: number) => void;
  chat?: (name: string, text: string, sys: boolean, from: number) => void;
  toast?: (text: string, kind: string) => void;
  mission?: (m: MissionView | null, result?: { ok: boolean; title: string; reward: number; xp: number; detail?: string }) => void;
  shot?: (m: Extract<ServerMsg, { t: 'shot' }>) => void;
  fx?: (m: Extract<ServerMsg, { t: 'fx' }>) => void;
  wasted?: (m: Extract<ServerMsg, { t: 'wasted' }>) => void;
  roster?: () => void;
  profile?: (p: Profile) => void;
  other?: (m: ServerMsg) => void;
  closed?: (reason: string) => void;
  /** local prediction events for sound / effects */
  jumped?: () => void;
  landed?: (impact: number) => void;
  impact?: (speed: number) => void;
  shifted?: () => void;
}

export class NetClient {
  id = 0;
  ready = false;
  /** predicted local character (always valid) */
  char: CharState = newChar(0, 0, 0);
  private prevChar: CharState = newChar(0, 0, 0);
  /** predicted own vehicle when driving */
  veh: VehState | null = null;
  private prevVeh: VehState = newVeh(0, 0, 0, 0);
  vehId = 0;
  seat = 0;
  vehSpecId = 0;
  // render-interpolated local state
  rx = 0; ry = 0; rz = 0; ryaw = 0;
  rvPitch = 0; rvRoll = 0;
  private ex = 0; private ey = 0; private ez = 0; private eyaw = 0; // visual error offsets (decay)

  players = new Map<number, Remote<SnapPlayer>>();
  vehicles = new Map<number, Remote<SnapVehicle>>();
  npcs = new Map<number, Remote<SnapNpc>>();
  roster = new Map<number, PlayerInfo>();
  lobby: LobbyInfo | null = null;
  profile: Profile = newProfile('Spieler');
  mission: MissionView | null = null;
  hours = 10;
  weather = { cover: 0.3, rain: 0, fog: 0, snow: 0, wind: 0.2 };
  wanted = 0;
  money = 0;
  ammo = 0;
  weapon = 1;
  ev: NetEvents = {};
  /** measured round trip time (ms) and server tick rate info */
  rtt = 0;
  /** correction magnitude of the last reconciliation (debug / tests) */
  lastCorrection = 0;
  snapshots = 0;
  bytesIn = 0;

  private seq = 0;
  private history: InputCmd[] = [];
  private acc = 0;
  private serverOffset = 0;
  private haveOffset = false;
  private clock = 0;
  private lastSnapTick = 0;
  private pingT = 0;
  private vin: VehInput = { steer: 0, throttle: 0, handbrake: false };
  private dyn: DynCircle[] = [];
  private circ: number[] = [];
  interpDelay = 0.1;
  /** simulation time in seconds (server clock) */
  simTime = 0;

  constructor(readonly world: World, readonly transport: Transport) {
    transport.onMessage = (m) => this.onMessage(m);
    transport.onClose = (r) => this.ev.closed?.(r);
    this.interpDelay = transport.kind === 'local' ? 0.055 : 0.1;
  }

  command(c: Command): void {
    this.transport.send({ t: 'cmd', c });
  }
  sendRaw(m: ClientMsg): void {
    this.transport.send(m);
  }
  get driving(): boolean {
    return this.veh !== null;
  }
  get inVehicle(): boolean {
    return this.vehId !== 0;
  }

  private onMessage(m: ServerMsg | ArrayBuffer): void {
    if (m instanceof ArrayBuffer) {
      this.bytesIn += m.byteLength;
      if (new Uint8Array(m)[0] === Pkt.Snapshot) this.onSnapshot(decodeSnapshot(m));
      return;
    }
    switch (m.t) {
      case 'welcome':
        this.id = m.id;
        this.profile = m.profile;
        this.lobby = m.lobby;
        this.roster.clear();
        for (const p of m.players) this.roster.set(p.id, p);
        this.history.length = 0;
        this.ready = false;
        this.haveOffset = false;
        this.players.clear(); this.vehicles.clear(); this.npcs.clear();
        this.ev.welcome?.(m.id);
        this.ev.roster?.();
        break;
      case 'join': this.roster.set(m.p.id, m.p); this.ev.roster?.(); break;
      case 'leave': this.roster.delete(m.id); this.players.delete(m.id); this.ev.roster?.(); break;
      case 'chat': this.ev.chat?.(m.name, m.text, !!m.sys, m.from); break;
      case 'toast': this.ev.toast?.(m.text, m.kind ?? 'info'); break;
      case 'profile': this.profile = m.profile; this.ev.profile?.(m.profile); break;
      case 'mission': this.mission = m.m; this.ev.mission?.(m.m, m.result); break;
      case 'shot': this.ev.shot?.(m); break;
      case 'fx': this.ev.fx?.(m); break;
      case 'wasted': this.ev.wasted?.(m); break;
      case 'pong': this.rtt = this.rtt * 0.7 + (performance.now() - m.c) * 0.3; break;
      default: this.ev.other?.(m);
    }
  }

  private onSnapshot(s: Snapshot): void {
    if (s.tick <= this.lastSnapTick && this.ready) return;
    this.lastSnapTick = s.tick;
    this.snapshots++;
    const ts = s.tick * DT;
    this.simTime = ts;
    const off = ts - this.clock;
    if (!this.haveOffset) { this.serverOffset = off; this.haveOffset = true; }
    else this.serverOffset += (off - this.serverOffset) * 0.08;
    this.hours = s.hours;
    this.weather = s.weather;
    this.wanted = s.wanted;
    this.money = s.money;
    this.ammo = s.ammo;
    this.weapon = s.weapon;

    // ---- reconcile the local entity
    const oldX = this.veh ? this.veh.x : this.char.x, oldY = this.veh ? this.veh.y : this.char.y, oldZ = this.veh ? this.veh.z : this.char.z, oldYaw = this.veh ? this.veh.yaw : this.char.yaw;
    const wasDriving = this.veh !== null, wasVeh = this.vehId;
    while (this.history.length && this.history[0].seq <= s.ack) this.history.shift();
    copyChar(this.char, s.me);
    this.vehId = s.myVeh;
    this.seat = s.mySeat;
    if (s.veh) {
      if (!this.veh) this.veh = newVeh(0, 0, 0, 0);
      copyVeh(this.veh, s.veh);
      const rv = s.vehicles.find((v) => v.id === s.myVeh);
      if (rv) this.vehSpecId = rv.spec;
    } else this.veh = null;
    for (const inp of this.history) this.predict(inp, true);
    const nx = this.veh ? this.veh.x : this.char.x, ny = this.veh ? this.veh.y : this.char.y, nz = this.veh ? this.veh.z : this.char.z, nyaw = this.veh ? this.veh.yaw : this.char.yaw;
    const dx = oldX - nx, dy = oldY - ny, dz = oldZ - nz;
    const err = Math.hypot(dx, dy, dz);
    this.lastCorrection = err;
    if (!this.ready || wasDriving !== (this.veh !== null) || wasVeh !== this.vehId || err > 4) {
      // first state, mode switch or teleport: snap
      this.ex = this.ey = this.ez = this.eyaw = 0;
      copyChar(this.prevChar, this.char);
      if (this.veh) copyVeh(this.prevVeh, this.veh);
    } else if (err > 0.0005) {
      this.ex += dx; this.ey += dy; this.ez += dz;
      this.eyaw += angleDiff(nyaw, oldYaw);
    }
    this.ready = true;

    // ---- remote entities
    const seenP = new Set<number>();
    for (const p of s.players) {
      seenP.add(p.id);
      let r = this.players.get(p.id);
      if (!r) this.players.set(p.id, (r = new Remote(p)));
      r.data = p;
      r.seen = this.clock;
      r.push(ts, p.x, p.y, p.z, p.yaw);
    }
    for (const id of this.players.keys()) if (!seenP.has(id)) this.players.delete(id);
    for (const v of s.vehicles) {
      let r = this.vehicles.get(v.id);
      if (!r || r.data.spec !== v.spec) this.vehicles.set(v.id, (r = new Remote(v)));
      r.data = v;
      r.seen = this.clock;
      r.push(ts, v.x, v.y, v.z, v.yaw);
    }
    for (const n of s.npcs) {
      let r = this.npcs.get(n.id);
      if (!r || r.data.look !== n.look) this.npcs.set(n.id, (r = new Remote(n)));
      r.data = n;
      r.seen = this.clock;
      r.push(ts, n.x, n.y, n.z, n.yaw);
    }
  }

  /** One prediction step with the same code the server runs. */
  private predict(inp: InputCmd, replay: boolean): void {
    if (this.veh) {
      const spec = vehicleSpec(this.vehSpecId);
      this.vin.steer = inp.mx;
      this.vin.throttle = inp.mz;
      this.vin.handbrake = (inp.buttons & BTN.HANDBRAKE) !== 0;
      const wet = 1 - this.weather.rain * 0.22 - this.weather.snow * 0.35;
      stepVehicle(this.veh, spec, this.vin, this.world, DT, wet);
      if (!replay) {
        if (vehEvents.impact > 2.5) this.ev.impact?.(vehEvents.impact);
        if (vehEvents.shifted) this.ev.shifted?.();
      }
      const c = this.char;
      c.x = this.veh.x; c.y = this.veh.y - spec.ride; c.z = this.veh.z; c.yaw = this.veh.yaw;
      c.prevButtons = inp.buttons;
      return;
    }
    if (this.vehId) return; // passenger: follows the interpolated vehicle
    const c = this.char;
    if (c.mode === CharMode.InVehicle) return;
    // nearby vehicles block the character exactly like on the server
    const dyn = this.dyn;
    dyn.length = 0;
    for (const r of this.vehicles.values()) {
      const dx = r.x - c.x, dz = r.z - c.z;
      if (dx * dx + dz * dz > 64) continue;
      const spec = vehicleSpec(r.data.spec);
      const rad = bodyCircles(spec, this.circ);
      for (const off of this.circ) dyn.push({ x: r.x + Math.sin(r.yaw) * off, z: r.z + Math.cos(r.yaw) * off, r: rad * 0.92, y0: r.y - spec.ride, y1: r.y - spec.ride + spec.height });
    }
    stepCharacter(c, inp, this.world, DT, dyn);
    if (!replay) {
      if (charEvents.jumped) this.ev.jumped?.();
      if (charEvents.landed > 2) this.ev.landed?.(charEvents.landed);
    }
  }

  /**
   * Advance the client: fixed-step input sampling + prediction, transport pump, interpolation.
   * @param sample fills an InputCmd from the current device state (called once per simulation tick)
   */
  update(dt: number, sample: (out: InputCmd) => void): void {
    this.clock += dt;
    this.transport.update(dt);
    if (!this.ready) return;
    this.acc = Math.min(this.acc + dt, DT * 6);
    while (this.acc >= DT) {
      this.acc -= DT;
      const inp: InputCmd = { seq: ++this.seq, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0 };
      sample(inp);
      quantizeInput(inp);
      copyChar(this.prevChar, this.char);
      if (this.veh) copyVeh(this.prevVeh, this.veh);
      this.history.push(inp);
      if (this.history.length > 240) this.history.shift();
      this.predict(inp, false);
      // send the last three inputs: cheap protection against packet loss
      this.transport.send(encodeInputs(this.history.slice(-3)));
    }
    // ---- render state of the local entity
    const a = this.acc / DT;
    const decay = Math.exp(-dt * 12);
    this.ex *= decay; this.ey *= decay; this.ez *= decay; this.eyaw *= decay;
    if (this.veh) {
      const p = this.prevVeh, c = this.veh;
      this.rx = lerp(p.x, c.x, a) + this.ex; this.ry = lerp(p.y, c.y, a) + this.ey; this.rz = lerp(p.z, c.z, a) + this.ez;
      this.ryaw = p.yaw + angleDiff(p.yaw, c.yaw) * a + this.eyaw;
      this.rvPitch = lerp(p.pitch, c.pitch, a); this.rvRoll = lerp(p.roll, c.roll, a);
    } else {
      const p = this.prevChar, c = this.char;
      this.rx = lerp(p.x, c.x, a) + this.ex; this.ry = lerp(p.y, c.y, a) + this.ey; this.rz = lerp(p.z, c.z, a) + this.ez;
      this.ryaw = p.yaw + angleDiff(p.yaw, c.yaw) * a + this.eyaw;
    }
    // ---- remotes
    const rt = this.clock + this.serverOffset - this.interpDelay;
    for (const [id, r] of this.vehicles) {
      if (this.clock - r.seen > 0.6) { this.vehicles.delete(id); continue; }
      r.sample(rt);
    }
    for (const [id, r] of this.npcs) {
      if (this.clock - r.seen > 0.6) { this.npcs.delete(id); continue; }
      r.sample(rt);
    }
    for (const r of this.players.values()) r.sample(rt);
    // passenger: ride along
    if (this.vehId && !this.veh) {
      const v = this.vehicles.get(this.vehId);
      if (v) { this.rx = v.x; this.ry = v.y; this.rz = v.z; this.ryaw = v.yaw; }
    }
    this.pingT -= dt;
    if (this.pingT <= 0) {
      this.pingT = 2;
      this.transport.send({ t: 'ping', c: performance.now() });
    }
    void VF;
  }
}
