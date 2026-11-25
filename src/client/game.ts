// The running game session: glues input, network prediction, entity views, camera, effects, HUD and audio together.
import * as THREE from 'three';
import { clamp, dist2 } from '../shared/math';
import type { World } from '../shared/world/world';
import { ZONE_NAMES } from '../shared/world/layout';
import { makeNearest } from '../shared/world/roads';
import { MissionView, Profile, defaultAppearance, unpackAppearance, xpProgress } from '../shared/net/protocol';
import { BTN, CF, CharMode, InputCmd, VF, vehicleSpec } from '../shared/sim/types';
import { ACTIVITIES, Activity } from '../shared/sim/missions';
import { NPC } from '../shared/sim/peds';
import { Engine } from './render/engine';
import { WorldView } from './render/worldview';
import { NetClient } from './net/client';
import { Input } from './input/input';
import { GameCamera } from './camera';
import { CharAnimState, CharacterModel } from './entities/charactermodel';
import { VehicleModel } from './entities/vehiclemodel';
import { Effects } from './effects';

export interface HudState {
  ready: boolean;
  speedKmh: number;
  gear: number;
  rpm: number;
  inVehicle: boolean;
  driving: boolean;
  vehicleName: string;
  vehicleHp: number;
  hp: number;
  stamina: number;
  wanted: number;
  money: number;
  ammo: number;
  weapon: number;
  aiming: boolean;
  hours: number;
  zone: string;
  street: string;
  x: number;
  z: number;
  yaw: number;
  camYaw: number;
  mission: MissionView | null;
  prompt: string;
  fps: number;
  ping: number;
  level: number;
  xpCur: number;
  xpNeed: number;
  dead: boolean;
  device: 'kbm' | 'pad';
  players: { id: number; name: string; x: number; z: number; yaw: number }[];
  blips: { x: number; z: number; kind: number }[];
  online: boolean;
  nearActivity: Activity | null;
  speedLimit: number;
}
export interface GameUi {
  frame(s: HudState): void;
  toast(text: string, kind: string): void;
  chat(name: string, text: string, sys: boolean, from: number): void;
  mission(m: MissionView | null, result?: { ok: boolean; title: string; reward: number; xp: number; detail?: string }): void;
  wasted(busted: boolean, fee: number, by?: string): void;
  roster(): void;
  profile(p: Profile): void;
  closed(reason: string): void;
}
export interface GameAudio {
  frame(s: AudioState): void;
  shot(x: number, y: number, z: number, own: boolean): void;
  crash(x: number, y: number, z: number, amount: number): void;
  explode(x: number, y: number, z: number): void;
  step(left: boolean, surface: number, run: boolean, wet: boolean): void;
  ui(kind: 'cash' | 'fail' | 'ok' | 'star' | 'shift' | 'jump' | 'land' | 'punch' | 'prop'): void;
}
export interface AudioVehicle { id: number; x: number; y: number; z: number; rpm: number; throttle: number; speed: number; slip: number; horn: boolean; siren: boolean; spec: number; own: boolean; engine: boolean }
export interface AudioState {
  cam: THREE.Vector3;
  forward: THREE.Vector3;
  vehicles: AudioVehicle[];
  rain: number;
  wind: number;
  hours: number;
  zone: number;
  tunnel: boolean;
  swim: boolean;
  speed: number;
  inVehicle: boolean;
  night: number;
  wanted: number;
}

export class Game {
  readonly cam: GameCamera;
  readonly effects: Effects;
  readonly hud: HudState;
  private me: CharacterModel;
  private chars = new Map<number, CharacterModel>();
  private npcModels = new Map<number, CharacterModel>();
  private vehModels = new Map<number, VehicleModel>();
  private nr = makeNearest();
  private focus = new THREE.Vector3();
  private anim: CharAnimState = { speed: 0, moveX: 0, moveZ: 1, grounded: true, crouch: false, swim: false, aim: false, aimPitch: 0, vy: 0, mode: 0, melee: 0, fired: false, armed: true, sprint: false };
  private aimYaw = 0;
  private aimPitch = 0;
  private fpsAcc = 0; private fpsN = 0; private fps = 60;
  private hudT = 0;
  private lastFireT = 0;
  private hoursSmooth = -1;
  private v3 = new THREE.Vector3();
  private v3b = new THREE.Vector3();
  private lastWanted = 0;
  private wasInVehicle = false;
  private audioVehicles: AudioVehicle[] = [];
  paused = false;
  /** free camera for photo / debug */
  ui: GameUi | null = null;
  audio: GameAudio | null = null;
  time = 0;

  constructor(readonly engine: Engine, readonly world: World, readonly view: WorldView, readonly net: NetClient, readonly input: Input) {
    this.cam = new GameCamera(engine.camera, world);
    this.effects = new Effects(world);
    engine.scene.add(this.effects.group);
    this.me = new CharacterModel(net.profile.appearance);
    this.me.onStep = (left) => this.audio?.step(left, this.world.surfaceAt(this.net.rx, this.net.rz), (this.net.char.flags & CF.SPRINT) !== 0 || this.anim.speed > 3, this.net.weather.rain > 0.3);
    engine.scene.add(this.me.group);
    this.hud = { ready: false, speedKmh: 0, gear: 1, rpm: 0, inVehicle: false, driving: false, vehicleName: '', vehicleHp: 1, hp: 100, stamina: 1, wanted: 0, money: 0, ammo: 0, weapon: 1, aiming: false, hours: 10, zone: '', street: '', x: 0, z: 0, yaw: 0, camYaw: 0, mission: null, prompt: '', fps: 60, ping: 0, level: 1, xpCur: 0, xpNeed: 500, dead: false, device: 'kbm', players: [], blips: [], online: net.transport.kind === 'online', nearActivity: null, speedLimit: 0 };

    const ev = net.ev;
    ev.welcome = () => {
      this.rebuildMe();
      this.cam.snapBehind(Math.PI);
    };
    ev.chat = (n, t, s, f) => this.ui?.chat(n, t, s, f);
    ev.toast = (t, k) => { this.ui?.toast(t, k); if (k === 'money') this.audio?.ui('cash'); else if (k === 'bad') this.audio?.ui('fail'); };
    ev.mission = (m, r) => { this.ui?.mission(m, r); if (r) this.audio?.ui(r.ok ? 'ok' : 'fail'); };
    ev.wasted = (m) => this.ui?.wasted(!!m.busted, m.fee, m.by);
    ev.roster = () => this.ui?.roster();
    ev.profile = (p) => { this.ui?.profile(p); };
    ev.closed = (r) => this.ui?.closed(r);
    ev.shot = (m) => {
      const own = m.by === net.id;
      let x = m.x, y = m.y, z = m.z;
      if (own) { this.me.muzzleWorld(this.v3); x = this.v3.x; y = this.v3.y; z = this.v3.z; this.cam.shake(0.12); this.input.rumble(0.3, 0.6, 70); }
      this.effects.tracer(x, y, z, m.hx, m.hy, m.hz);
      this.audio?.shot(m.x, m.y, m.z, own);
    };
    ev.fx = (m) => {
      if (m.kind === 'explode') { this.effects.explode(m.x, m.y, m.z); this.audio?.explode(m.x, m.y, m.z); if (dist2(m.x, m.z, net.rx, net.rz) < 50) this.cam.shake(0.8); }
      else if (m.kind === 'crash') this.audio?.crash(m.x, m.y, m.z, m.a ?? 0.5);
      else if (m.kind === 'punch') this.audio?.ui('punch');
      else if (m.kind === 'prop') this.audio?.ui('prop');
      else if (m.kind === 'cash') this.audio?.ui('cash');
    };
    ev.jumped = () => this.audio?.ui('jump');
    ev.landed = (i) => { this.audio?.ui('land'); if (i > 9) this.cam.shake(Math.min(0.6, (i - 8) * 0.06)); };
    ev.impact = (s) => { this.cam.shake(Math.min(0.7, s * 0.045)); this.input.rumble(Math.min(1, s / 14), Math.min(1, s / 9), 180); };
    ev.shifted = () => this.audio?.ui('shift');
  }

  private rebuildMe(): void {
    this.engine.scene.remove(this.me.group);
    const step = this.me.onStep;
    this.me = new CharacterModel(this.net.profile.appearance);
    this.me.onStep = step;
    this.engine.scene.add(this.me.group);
  }
  setAppearance(): void {
    this.rebuildMe();
  }

  private sample = (out: InputCmd): void => {
    const inp = this.input, net = this.net;
    let b = 0;
    if (net.driving) {
      out.mx = inp.steer;
      out.mz = inp.throttle;
      if (inp.handbrake) b |= BTN.HANDBRAKE;
      if (inp.horn) b |= BTN.HORN;
    } else {
      const yaw = this.cam.yaw;
      const s = Math.sin(yaw), c = Math.cos(yaw);
      out.mx = s * inp.moveY - c * inp.moveX;
      out.mz = c * inp.moveY + s * inp.moveX;
      if (inp.jump) b |= BTN.JUMP;
      if (inp.sprint) b |= BTN.SPRINT;
      if (inp.crouch) b |= BTN.CROUCH;
      if (inp.aim) b |= BTN.AIM;
      if (inp.fire && inp.aim) b |= BTN.FIRE;
      if (inp.walk) b |= BTN.WALK;
      if (this.meleeLatch > 0) { b |= BTN.MELEE; this.meleeLatch--; }
    }
    out.yaw = this.aimYaw;
    out.pitch = this.aimPitch;
    out.buttons = b;
  };
  private meleeLatch = 0;

  /** Context prompt + nearest activity for the HUD. */
  private context(): void {
    const net = this.net, h = this.hud, inp = this.input;
    const key = (k: string, pad: string) => (inp.device === 'pad' ? pad : k);
    h.nearActivity = null;
    h.prompt = '';
    const x = net.rx, z = net.rz;
    let near: Activity | null = null, nd = 1e9;
    for (const a of ACTIVITIES) {
      const d = dist2(a.x, a.z, x, z);
      if (d < nd) { nd = d; near = a; }
    }
    if (near && nd < (near.kind === 'dealer' ? 26 : near.kind === 'garage' ? 22 : 3.4)) h.nearActivity = near;
    if (net.char.mode === CharMode.Dead) return;
    if (net.inVehicle) {
      if (h.nearActivity?.kind === 'garage' && net.driving) h.prompt = `${key('R', 'RB')}  Reparieren`;
      return;
    }
    if (h.nearActivity) {
      const a = h.nearActivity;
      if (a.kind === 'dealer') { h.prompt = `${key('B', 'LB')}  ${a.title}`; return; }
      if (a.kind !== 'garage' && !net.mission) { h.prompt = `${key('E', 'Y')}  ${a.title} starten`; return; }
    }
    let best = 3.4;
    for (const r of net.vehicles.values()) {
      const spec = vehicleSpec(r.data.spec);
      const dx = x - r.x, dz = z - r.z;
      const s = Math.sin(r.yaw), c = Math.cos(r.yaw);
      const lf = dx * s + dz * c, ll = dx * c - dz * s;
      const d = Math.hypot(Math.max(0, Math.abs(ll) - spec.width / 2), Math.max(0, Math.abs(lf) - spec.length / 2));
      if (d < best && Math.abs(r.y - net.ry) < 3) { best = d; h.prompt = `${key('E', 'Y')}  ${spec.name}`; }
    }
  }

  update(dt: number): void {
    const { net, input, view, engine } = this;
    this.time += dt;
    input.poll(dt);
    if (!this.paused && !input.uiMode) {
      if (input.usePressed) net.command({ k: 'use' });
      if (input.lightsPressed) net.command({ k: 'toggle', what: 'lights' });
      if (input.sirenPressed) net.command({ k: 'toggle', what: 'siren' });
      if (input.weaponPressed) net.command({ k: 'weapon', slot: net.weapon ? 0 : 1 });
      if (input.meleePressed && !net.inVehicle && !(input.aim && net.weapon === 1)) this.meleeLatch = 2;
      if (input.camPressed) this.cam.zoomLevel = (this.cam.zoomLevel + 1) % 3;
    }
    // aim direction: from the character towards the point under the crosshair
    {
      const f = this.cam.forward;
      const cp = engine.camera.position;
      const px = cp.x + f.x * 70, py = cp.y + f.y * 70, pz = cp.z + f.z * 70;
      const ox = net.rx, oy = net.ry + 1.48, oz = net.rz;
      const dx = px - ox, dy = py - oy, dz = pz - oz;
      const l = Math.hypot(dx, dy, dz) || 1;
      this.aimYaw = Math.atan2(dx, dz);
      this.aimPitch = Math.asin(clamp(dy / l, -1, 1));
    }
    net.update(dt, this.sample);
    if (!net.ready) {
      view.update(dt, this.focus);
      return;
    }
    const c = net.char;
    const driving = net.driving, inVeh = net.inVehicle;
    if (inVeh !== this.wasInVehicle) {
      this.wasInVehicle = inVeh;
      if (inVeh) this.cam.snapBehind(net.ryaw);
    }

    // ---- world clock / weather
    if (this.hoursSmooth < 0 || Math.abs(net.hours - this.hoursSmooth) > 0.5) this.hoursSmooth = net.hours;
    this.hoursSmooth += (net.hours - this.hoursSmooth) * Math.min(1, dt * 2);
    view.hours = this.hoursSmooth;
    view.simTime = net.simTime;
    const w = view.weather;
    w.cover = net.weather.cover; w.rain = net.weather.rain; w.fog = net.weather.fog; w.snow = net.weather.snow; w.wind = net.weather.wind;
    w.flash = this.effects.flash;

    // ---- vehicles
    const veh = net.veh;
    const myVeh = net.vehId;
    const seen = new Set<number>();
    const groundAt = (x: number, z: number, y: number) => this.world.groundAt(x, z, y);
    this.audioVehicles.length = 0;
    for (const [id, r] of net.vehicles) {
      seen.add(id);
      let m = this.vehModels.get(id);
      if (!m || m.spec.id !== r.data.spec) {
        if (m) { engine.scene.remove(m.group); m.dispose(); }
        m = new VehicleModel(vehicleSpec(r.data.spec), r.data.color);
        this.vehModels.set(id, m);
        engine.scene.add(m.group);
      }
      const d = r.data;
      const own = id === myVeh && veh !== null;
      if (own && veh) {
        const fwd = veh.vx * Math.sin(veh.yaw) + veh.vz * Math.cos(veh.yaw);
        m.update(dt, net.rx, net.ry, net.rz, net.ryaw, net.rvPitch, net.rvRoll, fwd, veh.steer / m.spec.steerMax, veh.flags | (d.flags & (VF.LIGHTS | VF.SIREN)), groundAt, view.sky.night);
        m.enableHeadlight(engine.quality.maxLights > 0);
        this.audioVehicles.push({ id, x: net.rx, y: net.ry, z: net.rz, rpm: veh.rpm / m.spec.redline, throttle: veh.throttle, speed: Math.abs(fwd), slip: Math.max(veh.slipF, veh.slipR), horn: input.horn, siren: (d.flags & VF.SIREN) !== 0, spec: m.spec.id, own: true, engine: true });
      } else {
        m.update(dt, r.x, r.y, r.z, r.yaw, d.pitch, d.roll, d.speed, d.steer, d.flags, groundAt, view.sky.night);
        m.enableHeadlight(false);
        if (dist2(r.x, r.z, net.rx, net.rz) < 90) this.audioVehicles.push({ id, x: r.x, y: r.y, z: r.z, rpm: d.rpm, throttle: Math.abs(d.speed) > 0.5 ? 0.5 : 0, speed: Math.abs(d.speed), slip: d.slip, horn: (d.flags & VF.HORN) !== 0, siren: (d.flags & VF.SIREN) !== 0, spec: d.spec, own: false, engine: (d.flags & VF.ENGINE) !== 0 || d.driver !== 0 });
      }
      m.dirt = Math.min(0.7, m.dirt + Math.abs(d.speed) * dt * 0.00025 * (1 + net.weather.rain * 3));
    }
    for (const [id, m] of this.vehModels) if (!seen.has(id)) { engine.scene.remove(m.group); m.dispose(); this.vehModels.delete(id); }

    // ---- local character
    const a = this.anim;
    const meVisible = !inVeh;
    this.me.group.visible = meVisible;
    if (meVisible) {
      const s = Math.sin(net.ryaw), co = Math.cos(net.ryaw);
      a.speed = Math.hypot(c.vx, c.vz);
      const fwd = c.vx * s + c.vz * co, left = c.vx * co - c.vz * s;
      const l = Math.max(0.3, a.speed);
      a.moveZ = fwd / l; a.moveX = left / l;
      if (a.speed < 0.3) { a.moveZ = 1; a.moveX = 0; }
      a.grounded = (c.flags & CF.GROUND) !== 0;
      a.crouch = (c.flags & CF.CROUCH) !== 0;
      a.swim = (c.flags & CF.SWIM) !== 0;
      a.aim = (c.flags & CF.AIM) !== 0;
      a.aimPitch = this.aimPitch;
      a.vy = c.vy;
      a.mode = c.mode;
      a.melee = c.meleeT > 0 ? 1 - c.meleeT / 0.5 : 0;
      a.fired = c.fireT > 0.15 && this.time - this.lastFireT > 0.1;
      if (a.fired) this.lastFireT = this.time;
      a.armed = net.weapon === 1;
      a.sprint = (c.flags & CF.SPRINT) !== 0;
      this.me.update(dt, a, net.rx, net.ry, net.rz, net.ryaw, (x, z) => this.world.groundAt(x, z, net.ry + 1));
    }

    // ---- remote players
    const seenP = new Set<number>();
    const ra = _ra;
    for (const [id, r] of net.players) {
      seenP.add(id);
      let m = this.chars.get(id);
      if (!m) {
        const info = net.roster.get(id);
        m = new CharacterModel(info ? unpackAppearance(info.look) : defaultAppearance(id));
        this.chars.set(id, m);
        engine.scene.add(m.group);
      }
      const d = r.data;
      m.group.visible = d.veh === 0;
      if (!m.group.visible) continue;
      const s = Math.sin(r.yaw), co = Math.cos(r.yaw);
      ra.speed = r.speed;
      const l = Math.max(0.3, r.speed);
      ra.moveZ = (r.vx * s + r.vz * co) / l; ra.moveX = (r.vx * co - r.vz * s) / l;
      if (r.speed < 0.3) { ra.moveZ = 1; ra.moveX = 0; }
      ra.grounded = (d.flags & CF.GROUND) !== 0; ra.crouch = (d.flags & CF.CROUCH) !== 0; ra.swim = (d.flags & CF.SWIM) !== 0; ra.aim = (d.flags & CF.AIM) !== 0;
      ra.aimPitch = d.pitch; ra.vy = ra.grounded ? 0 : (r.b.y - r.a.y) / Math.max(0.02, r.b.t - r.a.t); ra.mode = d.mode;
      ra.melee = d.anim & 1 ? 0.4 : 0; ra.fired = (d.anim & 2) !== 0; ra.armed = (d.anim & 4) !== 0; ra.sprint = (d.flags & CF.SPRINT) !== 0; ra.cower = false;
      m.update(dt, ra, r.x, r.y, r.z, r.yaw);
    }
    for (const [id, m] of this.chars) if (!seenP.has(id)) { engine.scene.remove(m.group); this.chars.delete(id); }

    // ---- NPCs
    const seenN = new Set<number>();
    for (const [id, r] of net.npcs) {
      seenN.add(id);
      let m = this.npcModels.get(id);
      const d = r.data;
      if (!m) {
        m = new CharacterModel(defaultAppearance(d.look % 61), d.kind === 1);
        this.npcModels.set(id, m);
        engine.scene.add(m.group);
      }
      ra.speed = d.state === NPC.KNOCKED ? r.speed : d.speed;
      ra.moveZ = 1; ra.moveX = 0;
      ra.grounded = true; ra.crouch = false; ra.swim = false; ra.aim = d.state === NPC.AIM; ra.aimPitch = 0; ra.vy = 0;
      ra.mode = d.state === NPC.KNOCKED ? 1 : d.state === NPC.DEAD ? 2 : 0;
      ra.melee = 0; ra.fired = false; ra.armed = d.kind === 1; ra.sprint = d.state === NPC.RUN; ra.cower = d.state === NPC.COWER;
      if (d.state === NPC.KNOCKED) { ra.grounded = r.b.y - r.a.y < 0.01; ra.vy = (r.b.y - r.a.y) / Math.max(0.02, r.b.t - r.a.t); }
      m.update(dt, ra, r.x, r.y, r.z, r.yaw);
    }
    for (const [id, m] of this.npcModels) if (!seenN.has(id)) { engine.scene.remove(m.group); this.npcModels.delete(id); }

    // ---- camera
    const vspec = driving ? vehicleSpec(net.vehSpecId) : inVeh ? vehicleSpec(net.vehicles.get(myVeh)?.data.spec ?? 0) : null;
    const fwdSpeed = veh ? veh.vx * Math.sin(veh.yaw) + veh.vz * Math.cos(veh.yaw) : inVeh ? net.vehicles.get(myVeh)?.data.speed ?? 0 : 0;
    this.cam.update(dt, { x: net.rx, y: net.ry, z: net.rz, yaw: net.ryaw, vehicle: inVeh, speed: fwdSpeed, length: vspec?.length ?? 0, height: vspec?.height ?? 0, aim: a.aim && !inVeh, crouch: a.crouch, swim: a.swim, lateral: veh ? veh.ay : 0 }, this.paused ? 0 : input.lookX, this.paused ? 0 : input.lookY);
    this.focus.set(net.rx, net.ry, net.rz);

    // ---- effects, world
    const mis = net.mission;
    this.effects.update(dt, { rain: net.weather.rain, snow: net.weather.snow, secrets: net.profile.secrets, mission: mis ? { x: mis.x, z: mis.z, r: mis.r } : null, hideActivities: !!mis, cam: engine.camera.position });
    view.update(dt, this.focus);
    if (net.wanted > this.lastWanted) this.audio?.ui('star');
    this.lastWanted = net.wanted;

    // ---- audio
    if (this.audio) {
      const st = _as;
      st.cam = engine.camera.position; st.forward = this.cam.forward; st.vehicles = this.audioVehicles;
      st.rain = net.weather.rain; st.wind = net.weather.wind; st.hours = this.hoursSmooth; st.zone = this.world.zoneAt(net.rx, net.rz);
      st.tunnel = this.world.inTunnel(net.rx, net.rz, net.ry + 1); st.swim = a.swim && !inVeh; st.speed = inVeh ? Math.abs(fwdSpeed) : a.speed; st.inVehicle = inVeh; st.night = view.sky.night; st.wanted = net.wanted;
      this.audio.frame(st);
    }

    // ---- HUD (10 Hz for text, every frame for the cheap stuff)
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc >= 0.5) { this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; }
    const h = this.hud;
    h.ready = true;
    h.inVehicle = inVeh; h.driving = driving;
    h.speedKmh = Math.abs(fwdSpeed) * 3.6;
    h.gear = veh ? veh.gear : 1; h.rpm = veh && vspec ? veh.rpm / vspec.redline : 0;
    h.vehicleName = vspec?.name ?? ''; h.vehicleHp = veh && vspec ? veh.hp / vspec.hp : inVeh ? net.vehicles.get(myVeh)?.data.hp ?? 1 : 1;
    h.hp = c.hp; h.stamina = c.stamina; h.wanted = net.wanted; h.money = net.money; h.ammo = net.ammo; h.weapon = net.weapon; h.aiming = a.aim && !inVeh;
    h.hours = this.hoursSmooth; h.x = net.rx; h.z = net.rz; h.yaw = net.ryaw; h.camYaw = this.cam.yaw; h.mission = net.mission; h.fps = this.fps; h.ping = net.rtt;
    h.dead = c.mode === CharMode.Dead; h.device = input.device;
    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.12;
      h.zone = ZONE_NAMES[this.world.zoneAt(net.rx, net.rz)] ?? '';
      const n = this.world.roadIndex.nearest(net.rx, net.rz, 30, this.nr);
      h.street = n && !n.edge.name.startsWith('Gasse') ? n.edge.name : '';
      h.speedLimit = n && n.dist < n.edge.width / 2 + 2 ? Math.round((n.edge.speed * 3.6) / 10) * 10 : 0;
      const xp = xpProgress(net.profile.xp);
      h.level = xp.level; h.xpCur = xp.cur; h.xpNeed = xp.need;
      h.players.length = 0;
      for (const [id, r] of net.players) h.players.push({ id, name: net.roster.get(id)?.name ?? '?', x: r.x, z: r.z, yaw: r.yaw });
      h.blips.length = 0;
      for (const r of net.vehicles.values()) if (r.data.flags & 0x4000 && (r.data.flags & VF.SIREN || net.wanted > 0)) h.blips.push({ x: r.x, z: r.z, kind: 1 });
      this.context();
    }
    this.ui?.frame(h);
  }

  /** Head position of another player in screen space (name tags). */
  screenPos(id: number, out: { x: number; y: number; visible: boolean }): void {
    const m = this.chars.get(id);
    out.visible = false;
    if (!m || !m.group.visible) return;
    const p = this.v3b.copy(m.group.position);
    p.y += 2.05;
    const d = p.distanceTo(this.engine.camera.position);
    if (d > 60) return;
    p.project(this.engine.camera);
    if (p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) return;
    const { w, h } = this.engine.size;
    out.x = (p.x * 0.5 + 0.5) * w;
    out.y = (-p.y * 0.5 + 0.5) * h;
    out.visible = true;
  }

  dispose(): void {
    const sc = this.engine.scene;
    sc.remove(this.me.group, this.effects.group);
    for (const m of this.chars.values()) sc.remove(m.group);
    for (const m of this.npcModels.values()) sc.remove(m.group);
    for (const m of this.vehModels.values()) { sc.remove(m.group); m.dispose(); }
    this.chars.clear(); this.npcModels.clear(); this.vehModels.clear();
    this.net.transport.close();
  }
}
const _ra: CharAnimState = { speed: 0, moveX: 0, moveZ: 1, grounded: true, crouch: false, swim: false, aim: false, aimPitch: 0, vy: 0, mode: 0, melee: 0, fired: false, armed: false, sprint: false };
const _as: AudioState = { cam: new THREE.Vector3(), forward: new THREE.Vector3(), vehicles: [], rain: 0, wind: 0, hours: 12, zone: 0, tunnel: false, swim: false, speed: 0, inVehicle: false, night: 0, wanted: 0 };
