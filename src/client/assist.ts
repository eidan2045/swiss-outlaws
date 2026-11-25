// Sandbox aim assist ("Aimbot") and ESP. Only active when the lobby allows it (single player or private sandbox lobby).
import { angleDiff, clamp } from '../shared/math';
import type { World } from '../shared/world/world';
import { Collider, rayVsCollider } from '../shared/world/colliders';
import { CharMode } from '../shared/sim/types';
import { NPC } from '../shared/sim/peds';
import type { NetClient } from './net/client';

export interface AssistSettings {
  aimbot: boolean;
  /** 1 (gentle, narrow cone) .. 5 (instant snap, wide cone) */
  strength: number;
  autoFire: boolean;
  onlyWhenAiming: boolean;
  esp: boolean;
  /** which targets: players, police officers, all pedestrians */
  tPlayers: boolean;
  tPolice: boolean;
  tPeds: boolean;
}
export const defaultAssist: AssistSettings = { aimbot: false, strength: 3, autoFire: false, onlyWhenAiming: false, esp: false, tPlayers: true, tPolice: true, tPeds: false };

const CONE = [0, 8, 14, 24, 40, 75].map((d) => (d * Math.PI) / 180);
const SPEED = [0, 3, 6, 11, 20, 60];
const RANGE = 95;

export interface AssistTarget { kind: 'player' | 'npc'; id: number; x: number; y: number; z: number; dist: number }

export class Assist {
  target: AssistTarget | null = null;
  /** true while the assist wants the weapon raised and fired */
  wantAim = false;
  wantFire = false;
  private tmp: Collider[] = [];
  private losCache = new Map<string, { t: number; ok: boolean }>();
  private t = 0;

  constructor(private world: World) {}

  /** Line of sight from (ax,ay,az) to (bx,by,bz) against terrain and static colliders. */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    for (let s = 1.5; s < d - 0.5; s += 2) {
      const k = s / d;
      if (this.world.groundAt(ax + dx * k, az + dz * k, ay + dy * k + 1) > ay + dy * k) return false;
    }
    const hl = Math.hypot(dx, dz);
    if (hl < 0.01) return true;
    const ux = dx / hl, uz = dz / hl;
    for (let s = 0; s < hl; s += 16) {
      this.world.colliders.query(ax + ux * (s + 8), az + uz * (s + 8), 10, this.tmp);
      for (const c of this.tmp) {
        if (c.kind === 1 && c.hx < 0.35) continue; // posts and thin trunks do not block
        const t = rayVsCollider(ax, az, ux, uz, hl - 0.5, c);
        if (t < 0) continue;
        const y = ay + dy * (t / hl);
        if (y >= c.y0 && y <= c.y1) return false;
      }
    }
    return true;
  }

  private cachedLos(key: string, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const c = this.losCache.get(key);
    if (c && this.t - c.t < 0.12) return c.ok;
    const ok = this.los(ax, ay, az, bx, by, bz);
    this.losCache.set(key, { t: this.t, ok });
    return ok;
  }

  /** Candidate targets (also used for ESP). */
  *candidates(net: NetClient, s: AssistSettings): Generator<{ kind: 'player' | 'npc'; id: number; x: number; y: number; z: number }> {
    if (s.tPlayers) for (const [id, r] of net.players) {
      const d = r.data;
      if (d.veh || d.mode === CharMode.Dead) continue;
      yield { kind: 'player', id, x: r.x, y: r.y, z: r.z };
    }
    for (const [id, r] of net.npcs) {
      const d = r.data;
      if (d.state === NPC.DEAD || d.state === NPC.KNOCKED) continue;
      if (d.kind === 1 ? !s.tPolice : !s.tPeds) continue;
      yield { kind: 'npc', id, x: r.x, y: r.y, z: r.z };
    }
  }

  /**
   * Picks a target and turns the camera towards it.
   * @returns the new camera yaw/pitch (unchanged when no target)
   */
  update(dt: number, net: NetClient, s: AssistSettings, cam: { x: number; y: number; z: number }, camYaw: number, camPitch: number, aiming: boolean): { yaw: number; pitch: number } {
    this.t += dt;
    this.target = null;
    this.wantAim = this.wantFire = false;
    const out = { yaw: camYaw, pitch: camPitch };
    const c = net.char;
    if (!s.aimbot || net.inVehicle || c.mode !== CharMode.Normal) return out;
    if (s.onlyWhenAiming && !aiming) return out;
    const strength = clamp(Math.round(s.strength), 1, 5);
    const cone = CONE[strength];
    const fx = Math.sin(camYaw) * Math.cos(camPitch), fy = Math.sin(camPitch), fz = Math.cos(camYaw) * Math.cos(camPitch);
    const ox = net.rx, oy = net.ry + 1.48, oz = net.rz;
    let best: AssistTarget | null = null, bestScore = 1e9;
    for (const t of this.candidates(net, s)) {
      const tx = t.x, ty = t.y + 1.25, tz = t.z;
      const dx = tx - cam.x, dy = ty - cam.y, dz = tz - cam.z;
      const d = Math.hypot(dx, dy, dz);
      const dist = Math.hypot(tx - ox, tz - oz);
      if (dist > RANGE || dist < 0.8) continue;
      const ang = Math.acos(clamp((dx * fx + dy * fy + dz * fz) / d, -1, 1));
      if (ang > cone) continue;
      if (!this.cachedLos(`${t.kind}${t.id}`, ox, oy, oz, tx, ty, tz)) continue;
      const score = ang + dist * 0.004;
      if (score < bestScore) { bestScore = score; best = { kind: t.kind, id: t.id, x: tx, y: ty, z: tz, dist }; }
    }
    if (!best) return out;
    this.target = best;
    const dx = best.x - cam.x, dy = best.y - cam.y, dz = best.z - cam.z;
    const wantYaw = Math.atan2(dx, dz), wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
    const k = 1 - Math.exp(-SPEED[strength] * dt);
    out.yaw = camYaw + angleDiff(camYaw, wantYaw) * k;
    out.pitch = camPitch + (wantPitch - camPitch) * k;
    const err = Math.abs(angleDiff(out.yaw, wantYaw)) + Math.abs(out.pitch - wantPitch);
    this.wantAim = s.autoFire && net.weapon === 1 && net.ammo > 0;
    this.wantFire = this.wantAim && err < 0.06 + 0.25 / Math.max(3, best.dist);
    return out;
  }
}
