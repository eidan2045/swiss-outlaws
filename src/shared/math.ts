// Deterministic math helpers shared by client and server.
// World generation only uses the d* functions (pure arithmetic) so that every JS engine
// produces bit-identical worlds.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
export function smootherstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from);
}
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * t;
}
export function approach(cur: number, target: number, maxDelta: number): number {
  if (cur < target) return Math.min(cur + maxDelta, target);
  return Math.max(cur - maxDelta, target);
}
/** Frame-rate independent exponential damping factor. */
export function damp(lambda: number, dt: number): number {
  return 1 - Math.exp(-lambda * dt);
}
export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}
export function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}
export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}
export function distSq2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}

// ---- deterministic trig (polynomial, arithmetic only) ----
/** Deterministic sine, max error ~1e-6. */
export function dsin(x: number): number {
  // range reduce to [-PI, PI]
  x = x - TAU * Math.floor((x + Math.PI) / TAU);
  // fold to [-PI/2, PI/2]
  if (x > Math.PI / 2) x = Math.PI - x;
  else if (x < -Math.PI / 2) x = -Math.PI - x;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 - x2 / 39916800)))));
}
export function dcos(x: number): number {
  return dsin(x + Math.PI / 2);
}
/** Deterministic atan2, max error ~1e-4 rad (enough for layout decisions). */
export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x), ay = Math.abs(y);
  const mn = Math.min(ax, ay), mx = Math.max(ax, ay);
  const a = mn / mx;
  const s = a * a;
  let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (ay > ax) r = Math.PI / 2 - r;
  if (x < 0) r = Math.PI - r;
  if (y < 0) r = -r;
  return r;
}

// ---- hashing / RNG ----
export function hashInt(a: number): number {
  a = Math.imul(a ^ (a >>> 16), 0x7feb352d);
  a = Math.imul(a ^ (a >>> 15), 0x846ca68b);
  return (a ^ (a >>> 16)) >>> 0;
}
export function hash2i(x: number, y: number, seed = 0): number {
  return hashInt((Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x5bd1e995) ^ Math.imul(seed | 0, 0x27d4eb2f)) | 0);
}
/** Hash to [0,1). */
export function hash2(x: number, y: number, seed = 0): number {
  return hash2i(x, y, seed) / 4294967296;
}

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed | 0) || 0x9e3779b9;
  }
  /** [0,1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  fork(salt: number): Rng {
    return new Rng(hashInt((this.s ^ Math.imul(salt | 0, 0x9e3779b1)) | 0));
  }
}

// ---- noise (value-gradient, integer hashed, deterministic) ----
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function grad(h: number, x: number, y: number): number {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return x - y;
    case 2: return -x + y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}
/** Perlin-style gradient noise in roughly [-1, 1]. */
export function noise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = grad(hash2i(xi, yi, seed), xf, yf);
  const b = grad(hash2i(xi + 1, yi, seed), xf - 1, yf);
  const c = grad(hash2i(xi, yi + 1, seed), xf, yf - 1);
  const d = grad(hash2i(xi + 1, yi + 1, seed), xf - 1, yf - 1);
  return (a + (b - a) * u + (c + (d - c) * u - (a + (b - a) * u)) * v) * 0.7071;
}
export function fbm2(x: number, y: number, octaves: number, seed = 0, lacunarity = 2, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
/** Ridged multifractal in [0,1]. */
export function ridged2(x: number, y: number, octaves: number, seed = 0, lacunarity = 2.05, gain = 0.5): number {
  let amp = 0.5, freq = 1, sum = 0, prev = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise2(x * freq, y * freq, seed + i * 977));
    n *= n;
    sum += n * amp * prev;
    norm += amp;
    prev = clamp01(n * 1.6);
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// ---- 2D geometry helpers ----
export interface Vec2 { x: number; z: number }

/** Distance from point to segment, also returns param t in out[0]. */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number, out?: number[]): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = clamp01(t);
  if (out) out[0] = t;
  const cx = ax + dx * t, cz = az + dz * t;
  return Math.sqrt((px - cx) * (px - cx) + (pz - cz) * (pz - cz));
}

/** Catmull-Rom spline through points; returns resampled polyline with ~step spacing. */
export function catmullRom(points: Vec2[], step: number): Vec2[] {
  if (points.length < 3) {
    // straight line, just subdivide
    const out: Vec2[] = [];
    const a = points[0], b = points[points.length - 1];
    const n = Math.max(1, Math.round(dist2(a.x, a.z, b.x, b.z) / step));
    for (let i = 0; i <= n; i++) out.push({ x: lerp(a.x, b.x, i / n), z: lerp(a.z, b.z, i / n) });
    return out;
  }
  const out: Vec2[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    const segLen = dist2(p1.x, p1.z, p2.x, p2.z);
    const n = Math.max(1, Math.round(segLen / step));
    for (let j = 0; j < n; j++) {
      const t = j / n, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  out.push({ ...points[points.length - 1] });
  return out;
}
