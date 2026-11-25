// Third-person camera: orbit on foot (with over-the-shoulder aim), chase camera in vehicles, world collision, shake.
import * as THREE from 'three';
import { angleDiff, clamp, lerp } from '../shared/math';
import type { World } from '../shared/world/world';
import { Collider, rayVsCollider } from '../shared/world/colliders';

export interface CamTarget {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vehicle: boolean;
  speed: number; // signed forward speed (vehicle)
  length: number;
  height: number;
  aim: boolean;
  crouch: boolean;
  swim: boolean;
  lateral: number; // lateral acceleration for a subtle roll
}

export class GameCamera {
  yaw = Math.PI;
  pitch = -0.12;
  /** current boom length */
  dist = 3.4;
  fov = 60;
  /** 0 close, 1 normal, 2 far */
  zoomLevel = 1;
  trauma = 0;
  private orbit = 0;
  private idle = 9;
  private px = 0; private py = 0; private pz = 0; private havePivot = false;
  private tmp: Collider[] = [];
  private t = 0;
  readonly forward = new THREE.Vector3();

  constructor(private cam: THREE.PerspectiveCamera, private world: World) {}

  snapBehind(yaw: number): void {
    this.yaw = yaw;
    this.pitch = -0.12;
    this.orbit = 0;
    this.havePivot = false;
  }
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt: number, t: CamTarget, lookX: number, lookY: number): void {
    this.t += dt;
    const k = (r: number) => 1 - Math.exp(-r * dt);
    const zoom = [0.72, 1, 1.45][this.zoomLevel];
    let wantDist: number, pivotH: number, side = 0, wantFov = 60;
    if (t.vehicle) {
      // chase camera: follows the heading, free look decays back
      if (Math.abs(lookX) + Math.abs(lookY) > 0.0005) this.idle = 0;
      else this.idle += dt;
      this.orbit -= lookX;
      this.pitch = clamp(this.pitch + lookY, -0.9, 0.35);
      if (this.idle > 1.4) {
        this.orbit += -this.orbit * k(2.6);
        this.pitch += (-0.2 - this.pitch) * k(2.2);
      }
      this.orbit = clamp(this.orbit, -Math.PI, Math.PI);
      const base = t.speed < -3 ? t.yaw + Math.PI : t.yaw;
      this.yaw += angleDiff(this.yaw, base + this.orbit) * k(this.idle > 1.4 ? 4.2 : 14);
      wantDist = (3.6 + t.length * 0.6 + Math.min(4, Math.abs(t.speed) * 0.045)) * zoom;
      pivotH = 0.75 + t.height * 0.42;
      wantFov = 58 + Math.min(17, Math.abs(t.speed) * 0.3);
    } else {
      this.yaw -= lookX;
      this.pitch = clamp(this.pitch + lookY, -1.25, 1.1);
      this.orbit = 0;
      wantDist = (t.aim ? 1.75 : 3.5) * (t.aim ? 1 : zoom);
      pivotH = t.swim ? 1.5 : t.crouch ? 1.15 : 1.58;
      side = t.aim ? 0.52 : 0.28;
      wantFov = t.aim ? 46 : 60;
    }
    // smooth pivot (hides small simulation steps and kerb snaps)
    const tx = t.x, ty = t.y + pivotH, tz = t.z;
    if (!this.havePivot || Math.abs(tx - this.px) + Math.abs(tz - this.pz) > 30) { this.px = tx; this.py = ty; this.pz = tz; this.havePivot = true; }
    this.px += (tx - this.px) * k(t.vehicle ? 28 : 22);
    this.pz += (tz - this.pz) * k(t.vehicle ? 28 : 22);
    this.py += (ty - this.py) * k(t.vehicle ? 9 : 12);

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fx = Math.sin(this.yaw) * cp, fy = sp, fz = Math.cos(this.yaw) * cp;
    this.forward.set(fx, fy, fz);
    // right vector for forward (sin, cos) is (-cos, sin)
    const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);
    const ox = this.px + rx * side, oy = this.py, oz = this.pz + rz * side;

    // ---- collision: shorten the boom against terrain and buildings
    let maxD = wantDist;
    const steps = 9;
    for (let i = 1; i <= steps; i++) {
      const d = (wantDist * i) / steps;
      const x = ox - fx * d, y = oy - fy * d, z = oz - fz * d;
      if (this.world.groundAt(x, z, y + 1.5) + 0.3 > y) { maxD = Math.max(0.5, (wantDist * (i - 1)) / steps); break; }
    }
    const hl = Math.hypot(fx, fz);
    if (hl > 0.05) {
      const ux = -fx / hl, uz = -fz / hl;
      this.world.colliders.query(ox + ux * wantDist * 0.5 * hl, oz + uz * wantDist * 0.5 * hl, wantDist * 0.5 * hl + 1.5, this.tmp);
      for (const c of this.tmp) {
        if (c.kind === 1 && c.hx < 0.5) continue; // thin posts do not push the camera
        const t2 = rayVsCollider(ox, oz, ux, uz, maxD * hl + 0.3, c);
        if (t2 < 0) continue;
        const d = t2 / hl;
        const y = oy - fy * d;
        if (y > c.y0 && y < c.y1 && d - 0.3 < maxD) maxD = Math.max(0.45, d - 0.3);
      }
    }
    if (maxD < this.dist) this.dist = maxD;
    else this.dist += (maxD - this.dist) * k(5);

    let cx = ox - fx * this.dist, cy = oy - fy * this.dist, cz = oz - fz * this.dist;
    const g = this.world.groundAt(cx, cz, cy + 1.5) + 0.28;
    if (cy < g) cy = g;
    if (cy < this.world.waterLevel + 0.25 && this.world.waterDepthAt(cx, cz) > 0) cy = this.world.waterLevel + 0.25;
    // shake
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma;
      cx += Math.sin(this.t * 47) * 0.12 * s;
      cy += Math.sin(this.t * 53 + 1) * 0.1 * s;
      this.trauma = Math.max(0, this.trauma - dt * 1.6);
    }
    this.cam.position.set(cx, cy, cz);
    this.cam.lookAt(cx + fx, cy + fy, cz + fz);
    if (t.vehicle) this.cam.rotateZ(clamp(t.lateral * -0.0022, -0.035, 0.035));
    this.fov = lerp(this.fov, wantFov, k(5));
    if (Math.abs(this.cam.fov - this.fov) > 0.05) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }
}
