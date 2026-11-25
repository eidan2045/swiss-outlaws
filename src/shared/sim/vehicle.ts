// Vehicle dynamics: bicycle model with load transfer, friction circle, gearbox and spring-supported body.
// 2.5D (no roll-overs) – tuned for a mix of plausibility and fun. Shared by client prediction and server.
import { clamp, clamp01, sign } from '../math';
import type { World } from '../world/world';
import { SURF_GRIP } from '../world/world';
import { Collider, circleVsCollider } from '../world/colliders';
import { GRAVITY, VF, VehState, VehicleSpec } from './types';

export interface VehInput {
  /** -1 (left) .. +1 (right) */
  steer: number;
  /** -1 (brake / reverse) .. +1 */
  throttle: number;
  handbrake: boolean;
}
export interface VehEvents {
  /** strongest impact speed this step (m/s) */
  impact: number;
  /** id of a breakable prop that was knocked over, or -1 */
  brokeProp: number;
  shifted: boolean;
}
export const vehEvents: VehEvents = { impact: 0, brokeProp: -1, shifted: false };

const tmpC: Collider[] = [];
const hit = [0, 0, 0, 0];
const G = 9.81; // gravity for tyre loads and slopes (GRAVITY itself is exaggerated for snappy jumps)

function tire(a: number): number {
  return Math.sin(1.42 * Math.atan(8.5 * a));
}
function torqueCurve(x: number): number {
  // x = rpm / redline
  const t = 1 - (x - 0.64) * (x - 0.64) * 1.9;
  return clamp(t, 0.42, 1) * (x > 1 ? 0.2 : 1);
}

/** Circles approximating the body footprint: offsets along the forward axis and the radius. */
export function bodyCircles(spec: VehicleSpec, out: number[]): number {
  const r = spec.width * 0.5 + 0.04;
  const span = spec.length * 0.5 - r * 0.86;
  const n = Math.max(3, Math.ceil((span * 2) / (r * 1.5)) + 1);
  out.length = 0;
  for (let i = 0; i < n; i++) out.push(-span + (2 * span * i) / (n - 1));
  return r;
}
const circ: number[] = [];

export function stepVehicle(v: VehState, spec: VehicleSpec, inp: VehInput, world: World, dt: number, wetGrip = 1): void {
  vehEvents.impact = 0;
  vehEvents.brokeProp = -1;
  vehEvents.shifted = false;
  const wrecked = (v.flags & VF.WRECKED) !== 0;
  let steerIn = clamp(inp.steer, -1, 1), thr = clamp(inp.throttle, -1, 1);
  let handbrake = inp.handbrake;
  if (wrecked) { thr = 0; handbrake = true; }

  const sinY = Math.sin(v.yaw), cosY = Math.cos(v.yaw);
  const fx = sinY, fz = cosY; // forward
  const lx = cosY, lz = -sinY; // left
  const L = spec.wheelbase, hl = L * 0.5, ht = spec.track * 0.5;

  // ---------------- ground under the four wheels
  const yRef = v.y + 0.6;
  const hFL = world.groundAt(v.x + fx * hl + lx * ht, v.z + fz * hl + lz * ht, yRef);
  const hFR = world.groundAt(v.x + fx * hl - lx * ht, v.z + fz * hl - lz * ht, yRef);
  const hRL = world.groundAt(v.x - fx * hl + lx * ht, v.z - fz * hl + lz * ht, yRef);
  const hRR = world.groundAt(v.x - fx * hl - lx * ht, v.z - fz * hl - lz * ht, yRef);
  const hF = (hFL + hFR) * 0.5, hR = (hRL + hRR) * 0.5, hLe = (hFL + hRL) * 0.5, hRi = (hFR + hRR) * 0.5;
  const gAvg = (hF + hR) * 0.5;
  const slopeF = clamp((hF - hR) / L, -1.2, 1.2), slopeL = clamp((hLe - hRi) / spec.track, -1.2, 1.2);
  const targetY = gAvg + spec.ride;
  const water = world.waterLevel - gAvg;
  const inWater = water > 0.7 && v.y < world.waterLevel + 0.4;

  // ---------------- vertical: sprung body
  const k = (2 * Math.PI * spec.suspHz) ** 2, cDamp = 2 * spec.suspDamp * Math.sqrt(k);
  const pen = targetY - v.y;
  let onGround = pen > -0.16;
  let ayv: number;
  if (pen > -0.42) {
    ayv = k * pen - cDamp * v.vy;
    if (ayv < -GRAVITY) ayv = -GRAVITY;
  } else ayv = -GRAVITY;
  if (inWater) {
    // sinking car: buoyancy keeps it near the surface for a moment, then it settles
    ayv = -GRAVITY * 0.12 - v.vy * 2.5;
    onGround = false;
  }
  v.vy += ayv * dt;
  v.y += v.vy * dt;
  if (v.y < targetY - 0.2 && !inWater) {
    // bump stop
    if (v.vy < -5.5) vehEvents.impact = Math.max(vehEvents.impact, (-v.vy - 5.5) * 0.9);
    v.y = targetY - 0.2;
    if (v.vy < 0) v.vy = 0;
    onGround = true;
  }
  const load = onGround ? clamp((ayv + GRAVITY) / GRAVITY, 0.25, 1.9) : 0;

  // ---------------- steering
  const vf = v.vx * fx + v.vz * fz;
  let vl = v.vx * lx + v.vz * lz;
  const speed = Math.sqrt(v.vx * v.vx + v.vz * v.vz);
  const steerLimit = 1 / (1 + (Math.abs(vf) / 19) ** 2 * 1.1);
  const steerTarget = -steerIn * spec.steerMax * Math.max(0.16, steerLimit);
  const steerRate = (Math.abs(steerTarget) < Math.abs(v.steer) ? 3.6 : 2.4) * (0.55 + 0.45 * steerLimit);
  v.steer += clamp(steerTarget - v.steer, -steerRate * dt, steerRate * dt);
  const delta = v.steer;

  // ---------------- drivetrain
  let throttle = 0, brake = 0, reverse = (v.flags & VF.REVERSE) !== 0;
  if (thr > 0.02) {
    if (vf < -1.2) brake = thr;
    else { throttle = thr; reverse = false; }
  } else if (thr < -0.02) {
    if (vf > 1.2) brake = -thr;
    else { throttle = -thr; reverse = true; }
  } else if (Math.abs(vf) < 0.5) reverse = false;
  if (wrecked || inWater) throttle = 0;
  v.throttle += clamp(throttle - v.throttle, -dt * 8, dt * 6);

  // gearbox (automatic)
  const wheelRpm = (Math.abs(vf) / (2 * Math.PI * spec.wheelR)) * 60;
  const nG = spec.gears.length;
  if (reverse) v.gear = 0;
  else if (v.gear < 1) v.gear = 1;
  const ratio = (reverse ? spec.gears[0] * 0.92 : spec.gears[v.gear - 1]) * spec.final;
  let rpm = wheelRpm * ratio;
  const idle = spec.redline * 0.13;
  if (v.shiftT > 0) v.shiftT -= dt;
  else if (!reverse) {
    if (rpm > spec.redline * 0.93 && v.gear < nG) { v.gear++; v.shiftT = 0.22; vehEvents.shifted = true; }
    else if (v.gear > 1) {
      const lower = wheelRpm * spec.gears[v.gear - 2] * spec.final;
      if (lower < spec.redline * (0.5 + 0.22 * v.throttle)) { v.gear--; v.shiftT = 0.16; vehEvents.shifted = true; }
    }
  }
  // clutch slip / launch: let the engine rev above the wheel speed at low speed
  const launch = Math.max(idle, spec.redline * (0.26 + 0.3 * v.throttle) * clamp01(1 - Math.abs(vf) / 9));
  rpm = Math.max(rpm, launch);
  const rpmTarget = clamp(onGround ? rpm : Math.max(rpm, spec.redline * (0.2 + 0.75 * v.throttle)), idle, spec.redline * 1.02);
  v.rpm += (rpmTarget - v.rpm) * Math.min(1, dt * 9);

  const maxTorque = ((spec.powerKW * 1000) / ((0.82 * spec.redline * 2 * Math.PI) / 60)) * 1.38;
  let Fd = 0;
  if (v.shiftT <= 0 || reverse) Fd = (maxTorque * torqueCurve(v.rpm / spec.redline) * ratio * 0.9) / spec.wheelR * v.throttle * (reverse ? -0.55 : 1);
  // rev limiter in top gear
  if (!reverse && v.gear === nG && wheelRpm * ratio > spec.redline) Fd = 0;

  // ---------------- tyre forces
  const m = spec.mass;
  const surf = SURF_GRIP[world.surfaceAt(v.x, v.z)] * wetGrip;
  const mu = spec.grip * surf;
  const a = hl, b = hl;
  const axClamped = clamp(v.ax, -12, 12);
  const Wf = Math.max(0, (m * G * b) / L - (m * axClamped * spec.cgH) / L) * load;
  const Wr = Math.max(0, (m * G * a) / L + (m * axClamped * spec.cgH) / L) * load;
  let Fx = 0, Fyf = 0, Fyr = 0;
  let slipF = 0, slipR = 0;
  if (onGround) {
    // traction-limited drive force
    const Wd = spec.drive === 0 ? Wf : spec.drive === 1 ? Wr : Wf + Wr;
    const limit = mu * 1.05 * Wd;
    let useF = 0, useR = 0;
    if (Math.abs(Fd) > limit) {
      const spin = clamp01((Math.abs(Fd) - limit) / (limit + 1));
      if (spec.drive !== 0) slipR = Math.max(slipR, spin);
      if (spec.drive !== 1) slipF = Math.max(slipF, spin);
      Fd = sign(Fd) * limit;
    }
    const usage = Wd > 1 ? Math.abs(Fd) / (limit + 1) : 0;
    if (spec.drive === 0) useF = usage; else if (spec.drive === 1) useR = usage; else { useF = usage * 0.8; useR = usage * 0.8; }
    Fx += Fd;
    // brakes (front biased)
    if (brake > 0 && Math.abs(vf) > 0.05) {
      const want = brake * spec.brake * m;
      const cap = mu * (Wf + Wr);
      const Fb = Math.min(want, cap);
      if (want > cap * 1.02 && speed > 4) { slipF = Math.max(slipF, 0.5); slipR = Math.max(slipR, 0.5); }
      Fx -= sign(vf) * Fb;
      useF = Math.max(useF, (Fb / (cap + 1)) * 0.85);
      useR = Math.max(useR, (Fb / (cap + 1)) * 0.7);
    }
    if (handbrake && Math.abs(vf) > 0.05) {
      Fx -= sign(vf) * mu * Wr * 0.62;
      useR = Math.max(useR, 0.93);
      if (speed > 3) slipR = Math.max(slipR, clamp01(speed / 12));
    }
    // rolling resistance + engine braking
    if (Math.abs(vf) > 0.15) Fx -= sign(vf) * m * (0.14 + (v.throttle < 0.05 ? 0.55 : 0));
    // lateral (slip angles)
    const vfS = Math.max(Math.abs(vf), 2.4);
    const dir = vf >= 0 ? 1 : -1;
    const af = Math.atan2(vl + a * v.yawRate, vfS) - delta * dir;
    const ar = Math.atan2(vl - b * v.yawRate, vfS);
    const capF = Math.sqrt(Math.max(0.08, 1 - useF * useF)), capR = Math.sqrt(Math.max(0.06, 1 - useR * useR));
    Fyf = -mu * Wf * tire(af) * capF;
    Fyr = -mu * spec.gripRear * Wr * tire(ar) * capR;
    if (speed > 5) {
      slipF = Math.max(slipF, clamp01((Math.abs(af) - 0.16) * 3.2));
      slipR = Math.max(slipR, clamp01((Math.abs(ar) - 0.15) * 3.2));
    }
  }
  // aerodynamic drag
  Fx -= spec.drag * vf * Math.abs(vf);
  const gravF = onGround ? (-G * slopeF) / Math.sqrt(1 + slopeF * slopeF) : 0;
  const gravL = onGround ? (-G * slopeL) / Math.sqrt(1 + slopeL * slopeL) : 0;
  let axL = (Fx - Fyf * Math.sin(delta)) / m + gravF;
  let ayL = (Fyf * Math.cos(delta) + Fyr) / m + gravL;
  if (inWater) { axL -= vf * 1.6; ayL -= vl * 2.4; }

  // hold still on gentle slopes when parked / braking at standstill
  if (onGround && speed < 0.35 && v.throttle < 0.02 && Math.abs(slopeF) < 0.5 && Math.abs(slopeL) < 0.5) {
    v.vx *= 0.6; v.vz *= 0.6; v.yawRate *= 0.5;
    axL = 0; ayL = 0;
  }
  v.vx += (fx * axL + lx * ayL) * dt;
  v.vz += (fz * axL + lz * ayL) * dt;
  const Iz = m * a * b * 1.25;
  if (onGround) {
    v.yawRate += ((a * Fyf * Math.cos(delta) - b * Fyr) / Iz) * dt;
    // low-speed kinematic steering keeps parking manoeuvres stable
    const kLow = clamp01(1 - Math.abs(vf) / 5);
    if (kLow > 0) {
      const rKin = (vf * Math.tan(delta)) / L;
      v.yawRate += (rKin - v.yawRate) * Math.min(1, kLow * dt * 14);
      vl = v.vx * lx + v.vz * lz;
      const damp = Math.min(1, kLow * dt * 9);
      v.vx -= lx * vl * damp;
      v.vz -= lz * vl * damp;
    }
  } else v.yawRate *= 1 - Math.min(1, dt * (inWater ? 3 : 0.35));
  v.yaw += v.yawRate * dt;
  if (v.yaw > Math.PI) v.yaw -= Math.PI * 2;
  else if (v.yaw < -Math.PI) v.yaw += Math.PI * 2;
  v.x += v.vx * dt;
  v.z += v.vz * dt;
  v.ax += (axL - gravF - v.ax) * Math.min(1, dt * 12);
  v.ay += (ayL - gravL - v.ay) * Math.min(1, dt * 12);
  v.slipF += (slipF - v.slipF) * Math.min(1, dt * 10);
  v.slipR += (slipR - v.slipR) * Math.min(1, dt * 10);

  // ---------------- body attitude (terrain + lean)
  const pitchT = onGround ? Math.atan(slopeF) - clamp(v.ax, -9, 9) * 0.0085 : v.pitch + clamp(-v.vy * 0.004, -0.02, 0.02) - v.pitch * 0.02;
  const rollT = onGround ? Math.atan(slopeL) + clamp(v.ay, -12, 12) * 0.011 : v.roll * 0.98;
  v.pitch += (pitchT - v.pitch) * Math.min(1, dt * 9);
  v.roll += (rollT - v.roll) * Math.min(1, dt * 8);

  // ---------------- collisions with static world
  const r = bodyCircles(spec, circ);
  world.colliders.query(v.x, v.z, spec.length * 0.5 + 1.5, tmpC);
  const base = v.y - spec.ride;
  for (let ci = 0; ci < circ.length; ci++) {
    const off = circ[ci];
    for (const col of tmpC) {
      if (col.y1 < base + 0.35 || col.y0 > base + spec.height) continue;
      const px = v.x + Math.sin(v.yaw) * off, pz = v.z + Math.cos(v.yaw) * off;
      if (!circleVsCollider(px, pz, r, col, hit)) continue;
      if (col.soft) {
        // posts, signals and thin trunks give way to a moving car
        const sp = Math.sqrt(v.vx * v.vx + v.vz * v.vz);
        if (sp > 4.5) {
          if (vehEvents.brokeProp < 0) vehEvents.brokeProp = col.id ?? -1;
          v.vx *= 0.985; v.vz *= 0.985;
          vehEvents.impact = Math.max(vehEvents.impact, 1.2);
          continue;
        }
      }
      impulse(v, spec, px, pz, hit[2], hit[3], hit[0], hit[1], Iz);
    }
    // terrain walls: a step higher than the wheels can climb
    const px = v.x + Math.sin(v.yaw) * off, pz = v.z + Math.cos(v.yaw) * off;
    const th = world.groundAt(px, pz, yRef);
    if (th - base > 0.9) {
      const e = 0.6;
      let nx = world.groundAt(px - e, pz, yRef) - world.groundAt(px + e, pz, yRef), nz = world.groundAt(px, pz - e, yRef) - world.groundAt(px, pz + e, yRef);
      const nl = Math.sqrt(nx * nx + nz * nz);
      if (nl > 0.01) {
        nx /= nl; nz /= nl;
        impulse(v, spec, px, pz, nx, nz, nx * 0.12, nz * 0.12, Iz);
      }
    }
  }
  v.x = clamp(v.x, -world.half + 5, world.half - 5);
  v.z = clamp(v.z, -world.half + 5, world.half - 5);

  // ---------------- flags
  let f = v.flags & (VF.ENGINE | VF.LIGHTS | VF.SIREN | VF.HORN | VF.WRECKED);
  if (onGround) f |= VF.GROUND;
  if (handbrake) f |= VF.HANDBRAKE;
  if (reverse) f |= VF.REVERSE;
  if (brake > 0.05 || (handbrake && speed > 1)) f |= VF.BRAKE;
  if (inWater) f |= VF.WATER;
  v.flags = f;
}

/** Collision response of the body against a static obstacle at contact point (px,pz) with normal n. */
function impulse(v: VehState, spec: VehicleSpec, px: number, pz: number, nx: number, nz: number, pushX: number, pushZ: number, Iz: number): void {
  v.x += pushX;
  v.z += pushZ;
  const rx = px - v.x, rz = pz - v.z;
  // velocity of the contact point (ω × r in the xz plane with yaw about +y)
  const cvx = v.vx + v.yawRate * rz, cvz = v.vz - v.yawRate * rx;
  const vn = cvx * nx + cvz * nz;
  if (vn >= 0) return;
  const rn = rz * nx - rx * nz;
  const invM = 1 / spec.mass;
  const j = (-(1 + 0.18) * vn) / (invM + (rn * rn) / Iz);
  v.vx += j * nx * invM;
  v.vz += j * nz * invM;
  v.yawRate += (rn * j) / Iz;
  // scrape friction along the wall
  const tx = -nz, tz = nx;
  const vt = v.vx * tx + v.vz * tz;
  const fr = Math.min(Math.abs(vt), 0.3 * j * invM);
  v.vx -= sign(vt) * fr * tx;
  v.vz -= sign(vt) * fr * tz;
  v.yawRate = clamp(v.yawRate, -4, 4);
  vehEvents.impact = Math.max(vehEvents.impact, -vn);
}

/** Apply collision damage. Returns true when the vehicle just became a wreck. */
export function damageVehicle(v: VehState, amount: number): boolean {
  if (v.flags & VF.WRECKED) return false;
  v.hp -= amount;
  if (v.hp <= 0) {
    v.hp = 0;
    v.flags |= VF.WRECKED;
    v.flags &= ~VF.ENGINE;
    return true;
  }
  return false;
}

/** Vehicle ↔ vehicle collision (circle sets). Returns impact speed or 0. */
export function collideVehicles(a: VehState, sa: VehicleSpec, b: VehState, sb: VehicleSpec): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const reach = (sa.length + sb.length) * 0.5 + 0.5;
  if (dx * dx + dz * dz > reach * reach || Math.abs(a.y - b.y) > 2.2) return 0;
  const ca: number[] = [], cb: number[] = [];
  const ra = bodyCircles(sa, ca), rb = bodyCircles(sb, cb);
  const fax = Math.sin(a.yaw), faz = Math.cos(a.yaw), fbx = Math.sin(b.yaw), fbz = Math.cos(b.yaw);
  let best = 0, bnx = 0, bnz = 0, bpx = 0, bpz = 0;
  for (const oa of ca) {
    const ax = a.x + fax * oa, az = a.z + faz * oa;
    for (const ob of cb) {
      const bx = b.x + fbx * ob, bz = b.z + fbz * ob;
      const ex = bx - ax, ez = bz - az;
      const d2 = ex * ex + ez * ez, rr = ra + rb;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2), pen = rr - d;
        if (pen > best) { best = pen; bnx = ex / d; bnz = ez / d; bpx = ax + (ex / d) * ra; bpz = az + (ez / d) * ra; }
      }
    }
  }
  if (best <= 0) return 0;
  const ma = sa.mass, mb = sb.mass, tot = ma + mb;
  // separate
  a.x -= bnx * best * (mb / tot); a.z -= bnz * best * (mb / tot);
  b.x += bnx * best * (ma / tot); b.z += bnz * best * (ma / tot);
  const rax = bpx - a.x, raz = bpz - a.z, rbx = bpx - b.x, rbz = bpz - b.z;
  const vax = a.vx + a.yawRate * raz, vaz = a.vz - a.yawRate * rax;
  const vbx = b.vx + b.yawRate * rbz, vbz = b.vz - b.yawRate * rbx;
  const vn = (vbx - vax) * bnx + (vbz - vaz) * bnz;
  if (vn >= 0) return 0;
  const Ia = ma * sa.wheelbase * sa.wheelbase * 0.3125, Ib = mb * sb.wheelbase * sb.wheelbase * 0.3125;
  const rna = raz * bnx - rax * bnz, rnb = rbz * bnx - rbx * bnz;
  const j = (-(1 + 0.2) * vn) / (1 / ma + 1 / mb + (rna * rna) / Ia + (rnb * rnb) / Ib);
  a.vx -= (j * bnx) / ma; a.vz -= (j * bnz) / ma; a.yawRate -= (rna * j) / Ia;
  b.vx += (j * bnx) / mb; b.vz += (j * bnz) / mb; b.yawRate += (rnb * j) / Ib;
  a.yawRate = clamp(a.yawRate, -4, 4);
  b.yawRate = clamp(b.yawRate, -4, 4);
  return -vn;
}
