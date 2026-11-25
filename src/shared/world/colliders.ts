// Static collision shapes (2.5D): oriented boxes and circles with a vertical extent.
import { clamp, dcos, dsin } from '../math';

export interface Collider {
  /** 0 = box, 1 = circle */
  kind: 0 | 1;
  x: number;
  z: number;
  /** box half extents (local x / local z) or circle radius in hx */
  hx: number;
  hz: number;
  /** rotation (yaw) of the box; local z axis = (sin, cos) */
  rot: number;
  sin: number;
  cos: number;
  y0: number;
  y1: number;
  /** breakable props get knocked over by vehicles instead of stopping them */
  soft?: boolean;
  id?: number;
}

export function boxCollider(x: number, z: number, hx: number, hz: number, rot: number, y0: number, y1: number): Collider {
  return { kind: 0, x, z, hx, hz, rot, sin: dsin(rot), cos: dcos(rot), y0, y1 };
}
export function circleCollider(x: number, z: number, r: number, y0: number, y1: number, soft = false): Collider {
  return { kind: 1, x, z, hx: r, hz: r, rot: 0, sin: 0, cos: 1, y0, y1, soft };
}

export class ColliderGrid {
  readonly cell = 24;
  private grid = new Map<number, Collider[]>();
  all: Collider[] = [];
  private stamp = 0;
  private marks = new Map<Collider, number>();

  add(c: Collider): void {
    c.id = this.all.length;
    this.all.push(c);
    const r = c.kind === 1 ? c.hx : Math.sqrt(c.hx * c.hx + c.hz * c.hz);
    const x0 = Math.floor((c.x - r) / this.cell), x1 = Math.floor((c.x + r) / this.cell);
    const z0 = Math.floor((c.z - r) / this.cell), z1 = Math.floor((c.z + r) / this.cell);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const k = (cx + 512) * 4096 + (cz + 512);
        let a = this.grid.get(k);
        if (!a) this.grid.set(k, (a = []));
        a.push(c);
      }
  }

  /** Collect colliders overlapping the circle (x,z,r) into out (deduplicated). */
  query(x: number, z: number, r: number, out: Collider[]): Collider[] {
    out.length = 0;
    const x0 = Math.floor((x - r) / this.cell), x1 = Math.floor((x + r) / this.cell);
    const z0 = Math.floor((z - r) / this.cell), z1 = Math.floor((z + r) / this.cell);
    const stamp = ++this.stamp;
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const a = this.grid.get((cx + 512) * 4096 + (cz + 512));
        if (!a) continue;
        for (const c of a) {
          if ((c as any)._s === stamp) continue;
          (c as any)._s = stamp;
          out.push(c);
        }
      }
    return out;
  }
}

/** Push a circle out of a collider. Returns true when overlapping; out = (pushX, pushZ, nx, nz). */
export function circleVsCollider(px: number, pz: number, r: number, c: Collider, out: number[]): boolean {
  if (c.kind === 1) {
    const dx = px - c.x, dz = pz - c.z;
    const rr = r + c.hx;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return false;
    const d = Math.sqrt(d2) || 1e-4;
    out[2] = dx / d;
    out[3] = dz / d;
    out[0] = out[2] * (rr - d);
    out[1] = out[3] * (rr - d);
    return true;
  }
  // box: transform into local space (local x axis = (cos, -sin), local z axis = (sin, cos))
  const dx = px - c.x, dz = pz - c.z;
  const lx = dx * c.cos - dz * c.sin;
  const lz = dx * c.sin + dz * c.cos;
  const cx = clamp(lx, -c.hx, c.hx), cz = clamp(lz, -c.hz, c.hz);
  let nx = lx - cx, nz = lz - cz;
  let d2 = nx * nx + nz * nz;
  let pen: number;
  if (d2 > 1e-10) {
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    nx /= d;
    nz /= d;
    pen = r - d;
  } else {
    // centre inside the box: push out along the smallest overlap
    const ox = c.hx - Math.abs(lx), oz = c.hz - Math.abs(lz);
    if (ox < oz) {
      nx = lx > 0 ? 1 : -1;
      nz = 0;
      pen = ox + r;
    } else {
      nx = 0;
      nz = lz > 0 ? 1 : -1;
      pen = oz + r;
    }
  }
  // back to world
  const wx = nx * c.cos + nz * c.sin;
  const wz = -nx * c.sin + nz * c.cos;
  out[2] = wx;
  out[3] = wz;
  out[0] = wx * pen;
  out[1] = wz * pen;
  return true;
}

/** Ray (2D) vs collider, returns distance along the ray or -1. */
export function rayVsCollider(ox: number, oz: number, dx: number, dz: number, maxT: number, c: Collider): number {
  if (c.kind === 1) {
    const fx = ox - c.x, fz = oz - c.z;
    const b = fx * dx + fz * dz;
    const cc = fx * fx + fz * fz - c.hx * c.hx;
    const disc = b * b - cc;
    if (disc < 0) return -1;
    const t = -b - Math.sqrt(disc);
    return t >= 0 && t <= maxT ? t : -1;
  }
  const rx = ox - c.x, rz = oz - c.z;
  const lx = rx * c.cos - rz * c.sin, lz = rx * c.sin + rz * c.cos;
  const ldx = dx * c.cos - dz * c.sin, ldz = dx * c.sin + dz * c.cos;
  let t0 = 0, t1 = maxT;
  if (Math.abs(ldx) < 1e-9) {
    if (Math.abs(lx) > c.hx) return -1;
  } else {
    let a = (-c.hx - lx) / ldx, b = (c.hx - lx) / ldx;
    if (a > b) { const s = a; a = b; b = s; }
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return -1;
  }
  if (Math.abs(ldz) < 1e-9) {
    if (Math.abs(lz) > c.hz) return -1;
  } else {
    let a = (-c.hz - lz) / ldz, b = (c.hz - lz) / ldz;
    if (a > b) { const s = a; a = b; b = s; }
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return -1;
  }
  return t0;
}
