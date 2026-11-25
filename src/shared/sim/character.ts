// Deterministic third-person character movement (shared by client prediction and server).
import { angleDiff, clamp } from '../math';
import type { World } from '../world/world';
import { Collider, circleVsCollider } from '../world/colliders';
import { BTN, CF, CHAR_RADIUS, CharMode, CharState, GRAVITY, InputCmd, SPEED } from './types';

const tmpC: Collider[] = [];
const hit = [0, 0, 0, 0];
const STEP_UP = 0.55;

export interface CharEvents {
  /** landing impact speed (m/s) when > 0 */
  landed: number;
  jumped: boolean;
  meleeStart: boolean;
}
export const charEvents: CharEvents = { landed: 0, jumped: false, meleeStart: false };

/** Dynamic circular obstacles (vehicles, other characters) supplied by the caller. */
export interface DynCircle { x: number; z: number; r: number; y0: number; y1: number }

function resolveStatics(c: CharState, world: World): void {
  world.colliders.query(c.x, c.z, CHAR_RADIUS + 0.5, tmpC);
  for (const col of tmpC) {
    if (col.y1 < c.y + 0.45 || col.y0 > c.y + 1.7) continue;
    if (circleVsCollider(c.x, c.z, CHAR_RADIUS, col, hit)) {
      c.x += hit[0];
      c.z += hit[1];
      const vn = c.vx * hit[2] + c.vz * hit[3];
      if (vn < 0) {
        c.vx -= vn * hit[2];
        c.vz -= vn * hit[3];
      }
    }
  }
}

/** Height of walkable tops of low box colliders under the point (platforms, low walls). */
function platformTop(c: CharState, world: World, ground: number): number {
  let best = ground;
  for (const col of tmpC) {
    if (col.kind !== 0 || col.y1 > c.y + STEP_UP || col.y1 < ground) continue;
    const dx = c.x - col.x, dz = c.z - col.z;
    const lx = dx * col.cos - dz * col.sin, lz = dx * col.sin + dz * col.cos;
    if (Math.abs(lx) <= col.hx && Math.abs(lz) <= col.hz && col.y1 > best) best = col.y1;
  }
  return best;
}

export function stepCharacter(c: CharState, inp: InputCmd, world: World, dt: number, dyn?: DynCircle[]): void {
  charEvents.landed = 0;
  charEvents.jumped = false;
  charEvents.meleeStart = false;
  const pressed = inp.buttons & ~c.prevButtons;
  c.prevButtons = inp.buttons;
  if (c.meleeT > 0) c.meleeT = Math.max(0, c.meleeT - dt);
  if (c.fireT > 0) c.fireT = Math.max(0, c.fireT - dt);

  if (c.mode === CharMode.InVehicle) return;
  if (c.mode === CharMode.Dead) {
    c.vx *= 0.9;
    c.vz *= 0.9;
    inp = DEAD_INPUT;
  }
  if (c.mode === CharMode.Mantle) {
    c.modeT -= dt;
    const k = clamp(1 - c.modeT / 0.55, 0, 1);
    const e = k * k * (3 - 2 * k);
    c.y += (c.my - c.y) * Math.min(1, e * 1.4 + dt * 6);
    if (k > 0.45) {
      c.x += (c.mx - c.x) * Math.min(1, dt * 9);
      c.z += (c.mz - c.z) * Math.min(1, dt * 9);
    }
    c.vx = c.vy = c.vz = 0;
    if (c.modeT <= 0) {
      c.mode = CharMode.Normal;
      c.x = c.mx; c.y = c.my; c.z = c.mz;
      c.flags |= CF.GROUND;
    }
    return;
  }

  let grounded = (c.flags & CF.GROUND) !== 0;
  let swim = (c.flags & CF.SWIM) !== 0;
  const knocked = c.mode === CharMode.Knocked;
  if (knocked) {
    c.modeT -= dt;
    if (c.modeT <= 0 && grounded && c.hp > 0) c.mode = CharMode.Normal;
  }

  // ---------------- desired velocity
  let mx = inp.mx, mz = inp.mz;
  let mag = Math.sqrt(mx * mx + mz * mz);
  if (mag > 1) { mx /= mag; mz /= mag; mag = 1; }
  if (knocked || c.mode === CharMode.Dead) { mx = mz = mag = 0; }
  const aiming = (inp.buttons & BTN.AIM) !== 0 && !swim && !knocked;
  let crouch = (inp.buttons & BTN.CROUCH) !== 0 && grounded && !swim && !knocked;
  const wantSprint = (inp.buttons & BTN.SPRINT) !== 0 && mag > 0.3 && !crouch && !aiming && c.stamina > 0.02;
  let maxSpeed = swim ? (wantSprint ? SPEED.SWIM_FAST : SPEED.SWIM) : crouch ? SPEED.CROUCH : aiming ? SPEED.AIM : wantSprint ? SPEED.SPRINT : (inp.buttons & BTN.WALK) !== 0 ? SPEED.WALK : SPEED.JOG;
  // analogue stick: below half deflection the character walks
  let speed = maxSpeed * mag;
  if (!swim && !crouch && !aiming && !wantSprint && mag < 0.55) speed = Math.min(speed, SPEED.WALK * Math.min(1, mag / 0.5));
  // wading slows down
  const g0 = world.groundAt(c.x, c.z, c.y);
  const depth0 = world.waterLevel - g0;
  if (!swim && depth0 > 0.35 && c.y < world.waterLevel) speed *= clamp(1 - (depth0 - 0.35) * 0.55, 0.45, 1);
  if (wantSprint) c.stamina = Math.max(0, c.stamina - dt * 0.085);
  else c.stamina = Math.min(1, c.stamina + dt * 0.16);

  let tx = mag > 0.001 ? (mx / mag) * speed : 0, tz = mag > 0.001 ? (mz / mag) * speed : 0;
  // steep slopes: slide down, no climbing
  if (grounded && !swim) {
    world.slopeAt(c.x, c.z, _slope, c.y);
    const s2 = _slope.x * _slope.x + _slope.z * _slope.z;
    if (s2 > 1.15) {
      const s = Math.sqrt(s2);
      const dx = -_slope.x / s, dz = -_slope.z / s; // downhill
      const up = -(tx * dx + tz * dz);
      if (up > 0) { tx += dx * up; tz += dz * up; }
      const k = clamp((s - 1.07) * 5, 0, 5);
      tx += dx * k; tz += dz * k;
    }
  }
  const accel = knocked ? (grounded ? 5 : 0.5) : swim ? 6 : grounded ? (mag > 0.01 ? 26 : 34) : 4;
  let dvx = tx - c.vx, dvz = tz - c.vz;
  const dl = Math.sqrt(dvx * dvx + dvz * dvz);
  const maxD = accel * dt;
  if (dl > maxD) { dvx *= maxD / dl; dvz *= maxD / dl; }
  c.vx += dvx;
  c.vz += dvz;

  // ---------------- facing
  if (!knocked && c.mode !== CharMode.Dead) {
    if (aiming) c.yaw += clamp(angleDiff(c.yaw, inp.yaw), -16 * dt, 16 * dt);
    else if (mag > 0.05) c.yaw += clamp(angleDiff(c.yaw, Math.atan2(mx, mz)), -11 * dt, 11 * dt);
  }

  // ---------------- actions
  if (!knocked && c.mode === CharMode.Normal) {
    if (pressed & BTN.JUMP) {
      if (grounded && !crouch) {
        // mantle a low obstacle in front, otherwise jump
        if (!tryMantle(c, world)) {
          c.vy = 6.6;
          grounded = false;
          charEvents.jumped = true;
        }
      } else if (swim) tryMantle(c, world);
    }
    if ((pressed & BTN.MELEE) && c.meleeT <= 0 && !swim) {
      c.meleeT = 0.5;
      charEvents.meleeStart = true;
    }
  }
  if ((c.mode as CharMode) === CharMode.Mantle) return;

  // ---------------- integrate
  if (!grounded && !swim) c.vy -= GRAVITY * dt;
  const ox = c.x, oz = c.z;
  c.x += c.vx * dt;
  c.z += c.vz * dt;
  c.x = clamp(c.x, -world.half + 4, world.half - 4);
  c.z = clamp(c.z, -world.half + 4, world.half - 4);
  resolveStatics(c, world);
  if (dyn) {
    for (const d of dyn) {
      if (d.y1 < c.y + 0.3 || d.y0 > c.y + 1.7) continue;
      const dx = c.x - d.x, dz = c.z - d.z, rr = d.r + CHAR_RADIUS;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) {
        const dd = Math.sqrt(d2);
        c.x += (dx / dd) * (rr - dd);
        c.z += (dz / dd) * (rr - dd);
      }
    }
  }
  // terrain walls (quay walls, steep steps): block and slide
  let g = world.groundAt(c.x, c.z, c.y);
  if ((grounded || swim) && g - c.y > STEP_UP) {
    const gx = world.groundAt(c.x, oz, c.y), gz = world.groundAt(ox, c.z, c.y);
    if (gx - c.y <= STEP_UP) { c.z = oz; c.vz = 0; }
    else if (gz - c.y <= STEP_UP) { c.x = ox; c.vx = 0; }
    else { c.x = ox; c.z = oz; c.vx = c.vz = 0; }
    g = world.groundAt(c.x, c.z, c.y);
  }
  g = platformTop(c, world, g);
  c.y += c.vy * dt;

  // ---------------- water
  const depth = world.waterLevel - g;
  const floatY = world.waterLevel - 1.32;
  if (depth > 1.4 && c.y <= floatY + 0.05) {
    if (!swim && c.vy < -7) charEvents.landed = Math.min(9, -c.vy * 0.6);
    swim = true;
    grounded = false;
    c.vy = 0;
    c.y += (floatY - c.y) * Math.min(1, dt * 6);
  } else if (swim) {
    swim = false;
    if (c.y < g) c.y = g;
    grounded = true;
  }

  // ---------------- ground contact
  if (!swim) {
    if (grounded) {
      if (c.y - g < 0.62 && c.vy <= 0.01) {
        c.y = g;
        c.vy = 0;
      } else if (c.vy <= 0.01) grounded = false;
    }
    if (!grounded && c.y <= g && c.vy <= 0) {
      const impact = -c.vy;
      c.y = g;
      c.vy = 0;
      grounded = true;
      charEvents.landed = impact;
      if (impact > 13) {
        c.hp -= (impact - 13) * 6.5;
        if (impact > 16.5 || c.hp <= 0) { c.mode = CharMode.Knocked; c.modeT = 1.6; }
      }
    }
    if (c.vy > 0.01) grounded = false;
  }
  if (c.hp <= 0 && c.mode !== CharMode.Dead) {
    c.hp = 0;
    c.mode = CharMode.Dead;
    c.modeT = 0;
  }
  crouch = crouch && grounded;
  c.flags = (grounded ? CF.GROUND : 0) | (crouch ? CF.CROUCH : 0) | (swim ? CF.SWIM : 0) | (aiming ? CF.AIM : 0) | (wantSprint ? CF.SPRINT : 0);
}
const _slope = { x: 0, z: 0 };
const DEAD_INPUT: InputCmd = { seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0 };

/** Climb onto low obstacles / out of the water onto a ledge in front of the character. */
function tryMantle(c: CharState, world: World): boolean {
  const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
  for (const reach of [0.7, 1.0]) {
    const px = c.x + fx * reach, pz = c.z + fz * reach;
    let top = world.groundAt(px, pz, c.y + 2.2);
    world.colliders.query(px, pz, 0.6, tmpC);
    let blocked = false;
    for (const col of tmpC) {
      if (col.kind !== 0) continue;
      const dx = px - col.x, dz = pz - col.z;
      const lx = dx * col.cos - dz * col.sin, lz = dx * col.sin + dz * col.cos;
      if (Math.abs(lx) <= col.hx + 0.1 && Math.abs(lz) <= col.hz + 0.1) {
        if (col.y1 > c.y + 2.3) blocked = true;
        else if (col.y1 > top) top = col.y1;
      }
    }
    if (blocked) continue;
    const rise = top - c.y;
    if (rise > 0.5 && rise < 2.25) {
      c.mode = CharMode.Mantle;
      c.modeT = 0.55 + rise * 0.12;
      c.mx = px; c.my = top; c.mz = pz;
      c.vx = c.vy = c.vz = 0;
      c.flags &= ~CF.SWIM;
      return true;
    }
  }
  return false;
}

/** Knock a character down with an impulse (vehicle hits, explosions, heavy punches). */
export function knockDown(c: CharState, ix: number, iy: number, iz: number, time: number): void {
  if (c.mode === CharMode.Dead || c.mode === CharMode.InVehicle) return;
  c.mode = CharMode.Knocked;
  c.modeT = Math.max(c.modeT, time);
  c.vx = ix; c.vy = Math.max(c.vy, iy); c.vz = iz;
  if (iy > 0.5) c.flags &= ~CF.GROUND;
}
