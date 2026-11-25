// World assembly: heightfield, road carving, zones, surface types and spatial queries.
// Runs identically on client and server (deterministic arithmetic only).
import { clamp, clamp01, distToSegment, lerp, noise2 } from '../math';
import { POIS, Poi, WATER_LEVEL, WORLD_HALF, WORLD_SIZE, Zone, baseHeight, buildRoadDefs, zoneAt } from './layout';
import { ROAD_SPECS, RoadEdge, RoadGraph, RoadIndex, buildRoadGraph, makeNearest } from './roads';
import { CityData, buildCity } from './city';
import { ColliderGrid } from './colliders';

export const enum Surf {
  Grass = 0,
  Asphalt = 1,
  Cobble = 2,
  Paved = 3,
  Field = 4,
  Rock = 5,
  Snow = 6,
  Sand = 7,
  Forest = 8,
  Gravel = 9,
}
export const SURF_GRIP = [0.72, 1.0, 0.9, 0.95, 0.66, 0.8, 0.42, 0.6, 0.68, 0.7];

export const RES = 2; // metres per height sample
export const N = WORLD_SIZE / RES + 1; // 1537
export const ZRES = 8;
export const ZN = WORLD_SIZE / ZRES; // 384

export interface TunnelSeg {
  ax: number; az: number; ay: number;
  bx: number; bz: number; by: number;
  half: number;
}

export class World {
  readonly half = WORLD_HALF;
  readonly size = WORLD_SIZE;
  readonly waterLevel = WATER_LEVEL;
  /** physics ground height */
  height = new Float32Array(N * N);
  /** render height (lowered below roads, original bed below bridges) */
  heightVis = new Float32Array(N * N);
  surface = new Uint8Array(N * N);
  /** 1 = road carriageway/sidewalk footprint, 2 = bridge deck */
  roadMask = new Uint8Array(N * N);
  zone = new Uint8Array(ZN * ZN);
  roads!: RoadGraph;
  roadIndex!: RoadIndex;
  tunnels: TunnelSeg[] = [];
  city!: CityData;
  colliders = new ColliderGrid();
  pois: Poi[] = POIS;
  genMs = 0;

  // ------------------------------------------------------------ height queries
  private sample(arr: Float32Array, x: number, z: number): number {
    let fx = (x + WORLD_HALF) / RES, fz = (z + WORLD_HALF) / RES;
    if (fx < 0) fx = 0; else if (fx > N - 1.001) fx = N - 1.001;
    if (fz < 0) fz = 0; else if (fz > N - 1.001) fz = N - 1.001;
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const i = iz * N + ix;
    const a = arr[i], b = arr[i + 1], c = arr[i + N], d = arr[i + N + 1];
    return a + (b - a) * tx + (c + (d - c) * tx - (a + (b - a) * tx)) * tz;
  }
  /** Terrain surface height (top layer). */
  terrainAt(x: number, z: number): number {
    return this.sample(this.height, x, z);
  }
  visAt(x: number, z: number): number {
    return this.sample(this.heightVis, x, z);
  }
  private _tt = [0];
  /** Tunnel floor height at (x,z) or NaN when not inside a tunnel footprint. */
  tunnelFloorAt(x: number, z: number): number {
    for (const t of this.tunnels) {
      if (Math.abs(x - (t.ax + t.bx) * 0.5) > 60 || Math.abs(z - (t.az + t.bz) * 0.5) > 60) continue;
      const d = distToSegment(x, z, t.ax, t.az, t.bx, t.bz, this._tt);
      if (d < t.half) return lerp(t.ay, t.by, this._tt[0]);
    }
    return NaN;
  }
  /**
   * Ground height for an entity whose feet are at yRef. Chooses the tunnel floor when the entity
   * is inside a tunnel (below the rock above it), otherwise the terrain surface.
   */
  groundAt(x: number, z: number, yRef = 1e9): number {
    const top = this.sample(this.height, x, z);
    if (this.tunnels.length && yRef < top - 3) {
      const f = this.tunnelFloorAt(x, z);
      if (f === f && yRef < f + 6) return f;
    }
    return top;
  }
  inTunnel(x: number, z: number, y: number): boolean {
    if (!this.tunnels.length) return false;
    const top = this.sample(this.height, x, z);
    if (y > top - 3) return false;
    const f = this.tunnelFloorAt(x, z);
    return f === f && y < f + 6;
  }
  /** Approximate surface normal (not normalised y-up slope vector). */
  slopeAt(x: number, z: number, out: { x: number; z: number }, yRef = 1e9): void {
    const e = 1.0;
    out.x = (this.groundAt(x + e, z, yRef) - this.groundAt(x - e, z, yRef)) / (2 * e);
    out.z = (this.groundAt(x, z + e, yRef) - this.groundAt(x, z - e, yRef)) / (2 * e);
  }
  surfaceAt(x: number, z: number): Surf {
    const ix = clamp(Math.round((x + WORLD_HALF) / RES), 0, N - 1), iz = clamp(Math.round((z + WORLD_HALF) / RES), 0, N - 1);
    return this.surface[iz * N + ix];
  }
  zoneAt(x: number, z: number): Zone {
    const ix = clamp(Math.floor((x + WORLD_HALF) / ZRES), 0, ZN - 1), iz = clamp(Math.floor((z + WORLD_HALF) / ZRES), 0, ZN - 1);
    return this.zone[iz * ZN + ix];
  }
  /** Water depth (>0 when the ground is below the water surface). */
  waterDepthAt(x: number, z: number): number {
    return WATER_LEVEL - this.sample(this.height, x, z);
  }
  inBounds(x: number, z: number, margin = 0): boolean {
    return Math.abs(x) < WORLD_HALF - margin && Math.abs(z) < WORLD_HALF - margin;
  }
  poi(id: string): Poi {
    return this.pois.find((p) => p.id === id)!;
  }
}

let cached: World | null = null;
export function getWorld(onProgress?: (label: string, f: number) => void): World {
  if (!cached) cached = buildWorld(onProgress);
  return cached;
}

export function buildWorld(onProgress?: (label: string, f: number) => void): World {
  const t0 = Date.now();
  const w = new World();
  const H = w.height;
  onProgress?.('Gelände', 0.05);

  // 1. base terrain
  for (let iz = 0; iz < N; iz++) {
    const z = iz * RES - WORLD_HALF;
    for (let ix = 0; ix < N; ix++) {
      H[iz * N + ix] = baseHeight(ix * RES - WORLD_HALF, z);
    }
  }
  const base = new Float32Array(H);
  onProgress?.('Strassennetz', 0.35);

  // 2. roads
  const baseAt = (x: number, z: number) => w.terrainAt(x, z);
  const isStation = (x: number, z: number) => z > -424 && z < -334 && x < -140;
  w.roads = buildRoadGraph(buildRoadDefs(), baseAt, isStation);
  w.roadIndex = new RoadIndex(w.roads);
  onProgress?.('Strassen einpassen', 0.5);

  // 3. carve roads into the heightfield
  const tt = [0];
  const carve = (e: RoadEdge, pass: number) => {
    const spec = ROAD_SPECS[e.type];
    const halfRoad = e.width / 2 + e.sidewalk;
    const core = halfRoad + 1.2;
    const reach = core + 34;
    const surf = e.type === 'alley' ? Surf.Cobble : Surf.Asphalt;
    for (let i = 0; i < e.n - 1; i++) {
      const fa = e.flag[i], fb = e.flag[i + 1];
      if (fa === 2 && fb === 2) continue; // inside tunnel
      const ax = e.px[i], az = e.pz[i], bx = e.px[i + 1], bz = e.pz[i + 1];
      const isBridge = fa === 1 || fb === 1;
      const r = isBridge ? halfRoad + 0.6 : reach;
      const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r + WORLD_HALF) / RES)), ix1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + r + WORLD_HALF) / RES));
      const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - r + WORLD_HALF) / RES)), iz1 = Math.min(N - 1, Math.ceil((Math.max(az, bz) + r + WORLD_HALF) / RES));
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = iz * RES - WORLD_HALF;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = ix * RES - WORLD_HALF;
          const d = distToSegment(x, z, ax, az, bx, bz, tt);
          if (d > r) continue;
          const yr = lerp(e.py[i], e.py[i + 1], tt[0]);
          const k = iz * N + ix;
          if (pass === 0) {
            // embankments / cuttings
            if (isBridge || d <= core) continue;
            if (fa === 2 || fb === 2) continue;
            if (e.blend && base[k] > 0.6) {
              // mountain roads with imposed ramps pull the surrounding slope towards the road level
              const wgt = 1 - clamp01((d - core) / 40);
              H[k] = lerp(H[k], yr, wgt * wgt * (3 - 2 * wgt) * 0.85);
            }
            const lim = (d - core) * spec.bank;
            const h = H[k];
            if (h > yr + lim) H[k] = yr + lim;
            else if (h < yr - lim && base[k] > 0.6) H[k] = yr - lim;
          } else if (pass === 2) {
            // carriageways always win over neighbouring sidewalks (junctions)
            if (d <= e.width / 2 + 0.4) H[k] = yr;
          } else {
            if (d > (isBridge ? halfRoad + 0.6 : core)) continue;
            // sidewalks (and the strip up to the building line) sit one kerb height above the carriageway
            const kerb = e.sidewalk > 0 && d > e.width / 2 + 0.4 ? 0.15 : 0;
            if (isBridge) {
              H[k] = yr + kerb;
              w.roadMask[k] = 2;
            } else {
              H[k] = yr + kerb;
              if (d <= halfRoad + 0.2) w.roadMask[k] = 1;
            }
            if (d <= e.width / 2 + 0.6) w.surface[k] = surf;
            else if (d <= halfRoad + 0.2 && w.surface[k] !== Surf.Asphalt && w.surface[k] !== Surf.Cobble) w.surface[k] = Surf.Paved;
          }
        }
      }
    }
  };
  // surface defaults are filled after zoning; mark with 255 first
  w.surface.fill(255);
  for (const e of w.roads.edges) carve(e, 0);
  for (const e of w.roads.edges) carve(e, 1);
  for (const e of w.roads.edges) carve(e, 2);

  // 4. tunnels: segments + make sure there is rock above them
  for (const e of w.roads.edges) {
    for (let i = 0; i < e.n - 1; i++) {
      if (e.flag[i] !== 2 && e.flag[i + 1] !== 2) continue;
      const seg: TunnelSeg = { ax: e.px[i], az: e.pz[i], ay: e.py[i], bx: e.px[i + 1], bz: e.pz[i + 1], by: e.py[i + 1], half: e.width / 2 + 1.2 };
      w.tunnels.push(seg);
      if (e.flag[i] !== 2 || e.flag[i + 1] !== 2) continue;
      const r = seg.half + 3;
      const ix0 = Math.max(0, Math.floor((Math.min(seg.ax, seg.bx) - r + WORLD_HALF) / RES)), ix1 = Math.min(N - 1, Math.ceil((Math.max(seg.ax, seg.bx) + r + WORLD_HALF) / RES));
      const iz0 = Math.max(0, Math.floor((Math.min(seg.az, seg.bz) - r + WORLD_HALF) / RES)), iz1 = Math.min(N - 1, Math.ceil((Math.max(seg.az, seg.bz) + r + WORLD_HALF) / RES));
      for (let iz = iz0; iz <= iz1; iz++)
        for (let ix = ix0; ix <= ix1; ix++) {
          const d = distToSegment(ix * RES - WORLD_HALF, iz * RES - WORLD_HALF, seg.ax, seg.az, seg.bx, seg.bz, tt);
          if (d > r) continue;
          const need = lerp(seg.ay, seg.by, tt[0]) + 9.5;
          const k = iz * N + ix;
          if (H[k] < need) H[k] = need;
        }
    }
  }
  onProgress?.('Zonen', 0.62);

  // 5. zones (8 m grid)
  for (let iz = 0; iz < ZN; iz++) {
    const z = (iz + 0.5) * ZRES - WORLD_HALF;
    for (let ix = 0; ix < ZN; ix++) {
      const x = (ix + 0.5) * ZRES - WORLD_HALF;
      const h = w.terrainAt(x, z);
      const sx = (w.terrainAt(x + 6, z) - w.terrainAt(x - 6, z)) / 12, sz = (w.terrainAt(x, z + 6) - w.terrainAt(x, z - 6)) / 12;
      w.zone[iz * ZN + ix] = zoneAt(x, z, h, Math.sqrt(sx * sx + sz * sz));
    }
  }

  // 5b. wooded patches where villa quarters / farmland are far from any street
  const nr = makeNearest();
  for (let iz = 0; iz < ZN; iz++) {
    const z = (iz + 0.5) * ZRES - WORLD_HALF;
    for (let ix = 0; ix < ZN; ix++) {
      const zn = w.zone[iz * ZN + ix] as Zone;
      if (zn !== Zone.Hillside && zn !== Zone.Residential) continue;
      const x = (ix + 0.5) * ZRES - WORLD_HALF;
      const limit = (zn === Zone.Hillside ? 52 : 70) + 16 * noise2(x / 60, z / 60, 811);
      if (!w.roadIndex.nearest(x, z, limit, nr)) w.zone[iz * ZN + ix] = zn === Zone.Hillside ? Zone.Forest : Zone.Park;
    }
  }

  // 6. surface types + render heights
  const HV = w.heightVis;
  for (let iz = 0; iz < N; iz++) {
    const z = iz * RES - WORLD_HALF;
    const zi = Math.min(ZN - 1, (iz * RES / ZRES) | 0);
    for (let ix = 0; ix < N; ix++) {
      const k = iz * N + ix;
      const h = H[k];
      const m = w.roadMask[k];
      HV[k] = m === 2 ? base[k] : m === 1 ? h - 0.45 : h;
      if (w.surface[k] !== 255) continue;
      const x = ix * RES - WORLD_HALF;
      const zn = w.zone[zi * ZN + Math.min(ZN - 1, (ix * RES / ZRES) | 0)] as Zone;
      let s: Surf;
      switch (zn) {
        case Zone.OldTown: s = Surf.Cobble; break;
        case Zone.Downtown: case Zone.Business: s = Surf.Paved; break;
        case Zone.Industrial: s = Surf.Asphalt; break;
        case Zone.Station: s = Surf.Gravel; break;
        case Zone.Forest: s = Surf.Forest; break;
        case Zone.Rural: s = noise2(x / 90, z / 90, 7) > 0.05 ? Surf.Field : Surf.Grass; break;
        case Zone.Alpine: {
          const ixm = Math.max(1, Math.min(N - 2, ix)), izm = Math.max(1, Math.min(N - 2, iz));
          const sx = (H[izm * N + ixm + 1] - H[izm * N + ixm - 1]) / (2 * RES), sz = (H[(izm + 1) * N + ixm] - H[(izm - 1) * N + ixm]) / (2 * RES);
          const sl = Math.sqrt(sx * sx + sz * sz);
          const snowLine = 400 + 70 * noise2(x / 200, z / 200, 13) - 60 * clamp01((sl - 0.2) * 0.6);
          s = h > snowLine && sl < 1.25 ? Surf.Snow : sl > 0.95 ? Surf.Rock : Surf.Grass;
          break;
        }
        default: s = Surf.Grass;
      }
      if (h < 1.1 && h > -2 && zn !== Zone.OldTown && zn !== Zone.Downtown) s = Surf.Sand;
      w.surface[k] = s;
    }
  }
  onProgress?.('Gebäude', 0.72);

  // 7. city: buildings, props, colliders
  w.city = buildCity(w);
  onProgress?.('Fertig', 1);
  w.genMs = Date.now() - t0;
  return w;
}

export { makeNearest };
export function clampToWorld(v: number, margin = 6): number {
  return clamp(v, -WORLD_HALF + margin, WORLD_HALF - margin);
}
export function _unused(): number {
  return clamp01(0);
}
