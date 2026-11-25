// Core simulation types shared by client prediction and the authoritative room.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const GRAVITY = 20;

export const BTN = {
  JUMP: 1,
  SPRINT: 2,
  CROUCH: 4,
  AIM: 8,
  FIRE: 16,
  MELEE: 32,
  USE: 64,
  HANDBRAKE: 128,
  HORN: 256,
  WALK: 512,
} as const;

/** One tick of player input. On foot (mx,mz) is the desired world-space move vector; in a vehicle mx = steer (right +), mz = throttle. */
export interface InputCmd {
  seq: number;
  mx: number;
  mz: number;
  /** camera / aim yaw and pitch */
  yaw: number;
  pitch: number;
  buttons: number;
}
export function emptyInput(): InputCmd {
  return { seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0 };
}

export const enum CharMode {
  Normal = 0,
  Knocked = 1,
  Dead = 2,
  InVehicle = 3,
  Mantle = 4,
}
export const CF = { GROUND: 1, CROUCH: 2, SWIM: 4, AIM: 8, SPRINT: 16 } as const;

export interface CharState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  flags: number;
  mode: CharMode;
  modeT: number;
  hp: number;
  stamina: number;
  prevButtons: number;
  /** melee swing timer (>0 while swinging) and fire cooldown */
  meleeT: number;
  fireT: number;
  /** mantle target */
  mx: number;
  my: number;
  mz: number;
}
export function newChar(x: number, y: number, z: number, yaw = 0): CharState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, yaw, flags: CF.GROUND, mode: CharMode.Normal, modeT: 0, hp: 100, stamina: 1, prevButtons: 0, meleeT: 0, fireT: 0, mx: 0, my: 0, mz: 0 };
}
export function copyChar(dst: CharState, src: CharState): CharState {
  dst.x = src.x; dst.y = src.y; dst.z = src.z; dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz; dst.yaw = src.yaw;
  dst.flags = src.flags; dst.mode = src.mode; dst.modeT = src.modeT; dst.hp = src.hp; dst.stamina = src.stamina; dst.prevButtons = src.prevButtons;
  dst.meleeT = src.meleeT; dst.fireT = src.fireT; dst.mx = src.mx; dst.my = src.my; dst.mz = src.mz;
  return dst;
}

export const CHAR_RADIUS = 0.34;
export const CHAR_HEIGHT = 1.8;
export const SPEED = { WALK: 1.7, JOG: 3.7, SPRINT: 6.5, CROUCH: 1.3, SWIM: 1.5, SWIM_FAST: 2.6, AIM: 2.2 };

// ---------------------------------------------------------------- vehicles
export const VF = { GROUND: 1, HANDBRAKE: 2, REVERSE: 4, ENGINE: 8, LIGHTS: 16, SIREN: 32, HORN: 64, WRECKED: 128, BRAKE: 256, WATER: 512 } as const;

export interface VehicleSpec {
  id: number;
  key: string;
  name: string;
  cls: 'compact' | 'sedan' | 'sport' | 'suv' | 'van' | 'police' | 'bus' | 'truck';
  mass: number;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  track: number;
  wheelR: number;
  /** centre of gravity height above ground */
  cgH: number;
  /** body origin (y of state) height above ground at rest */
  ride: number;
  powerKW: number;
  redline: number;
  gears: number[];
  final: number;
  /** 0 fwd, 1 rwd, 2 awd */
  drive: 0 | 1 | 2;
  /** peak braking deceleration m/s² */
  brake: number;
  grip: number;
  gripRear: number;
  steerMax: number;
  /** aerodynamic drag coefficient (0.5·ρ·Cd·A) */
  drag: number;
  /** suspension natural frequency (Hz) and damping ratio */
  suspHz: number;
  suspDamp: number;
  seats: number;
  hp: number;
  price: number;
  /** level required to buy */
  level: number;
}

const base = { final: 3.9, suspHz: 1.9, suspDamp: 0.42, seats: 4, hp: 1000 };
export const VEHICLES: VehicleSpec[] = [
  { ...base, id: 0, key: 'kompakt', name: 'Albis GT', cls: 'compact', mass: 1240, length: 4.1, width: 1.78, height: 1.46, wheelbase: 2.6, track: 1.54, wheelR: 0.31, cgH: 0.52, ride: 0.33, powerKW: 118, redline: 6600, gears: [3.5, 2.05, 1.38, 1.02, 0.82, 0.68], drive: 0, brake: 10, grip: 1.05, gripRear: 1.04, steerMax: 0.6, drag: 0.4, price: 18000, level: 1 },
  { ...base, id: 1, key: 'limo', name: 'Rigi 5', cls: 'sedan', mass: 1620, length: 4.82, width: 1.86, height: 1.44, wheelbase: 2.9, track: 1.6, wheelR: 0.33, cgH: 0.5, ride: 0.32, powerKW: 195, redline: 6500, gears: [3.9, 2.3, 1.55, 1.15, 0.9, 0.72, 0.6], drive: 1, brake: 10.5, grip: 1.08, gripRear: 1.02, steerMax: 0.58, drag: 0.41, price: 46000, level: 2 },
  { ...base, id: 2, key: 'sport', name: 'Säntis RS', cls: 'sport', mass: 1430, length: 4.5, width: 1.94, height: 1.27, wheelbase: 2.62, track: 1.66, wheelR: 0.34, cgH: 0.44, ride: 0.27, powerKW: 345, redline: 8200, gears: [3.3, 2.15, 1.55, 1.2, 0.97, 0.8, 0.66], final: 3.6, drive: 1, brake: 12, grip: 1.3, gripRear: 1.05, steerMax: 0.56, drag: 0.38, suspHz: 2.4, suspDamp: 0.5, seats: 2, price: 185000, level: 6 },
  { ...base, id: 3, key: 'suv', name: 'Gotthard X', cls: 'suv', mass: 2080, length: 4.78, width: 1.96, height: 1.72, wheelbase: 2.85, track: 1.66, wheelR: 0.37, cgH: 0.68, ride: 0.46, powerKW: 215, redline: 6000, gears: [4.2, 2.5, 1.6, 1.15, 0.88, 0.7], drive: 2, brake: 9.6, grip: 1.02, gripRear: 1.03, steerMax: 0.58, drag: 0.58, suspHz: 1.6, price: 72000, level: 4 },
  { ...base, id: 4, key: 'van', name: 'Furka Cargo', cls: 'van', mass: 2250, length: 5.3, width: 2.0, height: 2.3, wheelbase: 3.3, track: 1.7, wheelR: 0.35, cgH: 0.85, ride: 0.42, powerKW: 112, redline: 4800, gears: [4.6, 2.6, 1.6, 1.1, 0.85, 0.7], drive: 0, brake: 8.8, grip: 0.94, gripRear: 1.05, steerMax: 0.6, drag: 0.82, suspHz: 1.5, seats: 2, price: 39000, level: 1 },
  { ...base, id: 5, key: 'polizei', name: 'Kapo Patrouille', cls: 'police', mass: 1780, length: 4.76, width: 1.88, height: 1.5, wheelbase: 2.86, track: 1.6, wheelR: 0.34, cgH: 0.52, ride: 0.34, powerKW: 260, redline: 6600, gears: [3.9, 2.3, 1.55, 1.15, 0.9, 0.72], drive: 2, brake: 11, grip: 1.16, gripRear: 1.04, steerMax: 0.58, drag: 0.44, price: 0, level: 99 },
  { ...base, id: 6, key: 'bus', name: 'VBZ Linienbus', cls: 'bus', mass: 11500, length: 11.6, width: 2.55, height: 3.05, wheelbase: 5.9, track: 2.1, wheelR: 0.48, cgH: 1.2, ride: 0.55, powerKW: 240, redline: 2400, gears: [5.6, 3.1, 1.9, 1.3, 1.0, 0.78], final: 5.2, drive: 1, brake: 7.5, grip: 0.9, gripRear: 1.08, steerMax: 0.72, drag: 2.3, suspHz: 1.3, seats: 2, hp: 2600, price: 0, level: 99 },
];
export function vehicleSpec(id: number): VehicleSpec {
  return VEHICLES[id] || VEHICLES[0];
}

export interface VehState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  vx: number;
  vy: number;
  vz: number;
  yawRate: number;
  steer: number;
  rpm: number;
  gear: number;
  shiftT: number;
  flags: number;
  hp: number;
  /** tyre slip intensity 0..1 (front / rear) for sound and skid marks */
  slipF: number;
  slipR: number;
  /** last local accelerations (weight transfer, visual lean) */
  ax: number;
  ay: number;
  throttle: number;
}
export function newVeh(x: number, y: number, z: number, yaw: number, hp = 1000): VehState {
  return { x, y, z, yaw, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, yawRate: 0, steer: 0, rpm: 900, gear: 1, shiftT: 0, flags: 1, hp, slipF: 0, slipR: 0, ax: 0, ay: 0, throttle: 0 };
}
export function copyVeh(d: VehState, s: VehState): VehState {
  d.x = s.x; d.y = s.y; d.z = s.z; d.yaw = s.yaw; d.pitch = s.pitch; d.roll = s.roll; d.vx = s.vx; d.vy = s.vy; d.vz = s.vz; d.yawRate = s.yawRate;
  d.steer = s.steer; d.rpm = s.rpm; d.gear = s.gear; d.shiftT = s.shiftT; d.flags = s.flags; d.hp = s.hp; d.slipF = s.slipF; d.slipR = s.slipR; d.ax = s.ax; d.ay = s.ay; d.throttle = s.throttle;
  return d;
}
