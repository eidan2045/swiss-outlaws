// Road graph: authored polylines → auto-intersected graph with smoothed height profiles.
import { Vec2, catmullRom, clamp, dist2, distToSegment, dsin, lerp } from '../math';
import { RoadDef, RoadType } from './layout';

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  y: number;
  edges: number[];
  signal: boolean;
}
export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  type: RoadType;
  name: string;
  /** carriageway width (m) */
  width: number;
  /** sidewalk width on each side (0 = none) */
  sidewalk: number;
  /** lanes per direction */
  lanes: number;
  /** speed limit m/s */
  speed: number;
  n: number;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  cum: Float32Array;
  length: number;
  /** per sample: 1 = bridge deck, 2 = tunnel */
  flag: Uint8Array;
  tram: boolean;
  noBuildings: boolean;
  /** terrain is blended towards this road (mountain roads with imposed ramp profile) */
  blend: boolean;
}
export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  /** railway polylines (visual) */
  tracks: Vec2[][];
}

export const ROAD_SPECS: Record<RoadType, { width: number; sidewalk: number; lanes: number; speed: number; bank: number }> = {
  highway: { width: 17, sidewalk: 0, lanes: 2, speed: 100 / 3.6, bank: 0.55 },
  main: { width: 11, sidewalk: 3, lanes: 1, speed: 50 / 3.6, bank: 0.6 },
  street: { width: 7.2, sidewalk: 2.2, lanes: 1, speed: 40 / 3.6, bank: 0.6 },
  alley: { width: 5.2, sidewalk: 0, lanes: 1, speed: 20 / 3.6, bank: 0.6 },
  rural: { width: 7, sidewalk: 0, lanes: 1, speed: 80 / 3.6, bank: 1.0 },
  track: { width: 30, sidewalk: 0, lanes: 0, speed: 0, bank: 0.5 },
};
export const SAMPLE_STEP = 6;

interface Poly {
  def: RoadDef;
  x: number[];
  z: number[];
  cum: number[];
  tunnel: Uint8Array;
  splits: { s: number; node: number }[];
  /** imposed height per sample (ramp roads) */
  rampY: number[] | null;
}

function resample(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [{ ...pts[0] }];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let ax = pts[i - 1].x, az = pts[i - 1].z;
    const bx = pts[i].x, bz = pts[i].z;
    let seg = dist2(ax, az, bx, bz);
    while (acc + seg >= step) {
      const t = (step - acc) / seg;
      ax = lerp(ax, bx, t);
      az = lerp(az, bz, t);
      out.push({ x: ax, z: az });
      seg = dist2(ax, az, bx, bz);
      acc = 0;
    }
    acc += seg;
  }
  const last = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (dist2(prev.x, prev.z, last.x, last.z) > step * 0.35) out.push({ ...last });
  else out[out.length - 1] = { ...last };
  return out;
}

function segIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number, out: number[]): boolean {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return false;
  out[0] = t;
  out[1] = u;
  return true;
}

export function buildRoadGraph(defs: RoadDef[], heightAt: (x: number, z: number) => number, isStation: (x: number, z: number) => boolean): RoadGraph {
  const polys: Poly[] = [];
  const tracks: Vec2[][] = [];

  // 1. polylines
  for (const def of defs) {
    const smooth = def.smooth !== false && def.pts.length > 2;
    let pts = smooth ? catmullRom(def.pts, 3) : catmullRom([def.pts[0], def.pts[def.pts.length - 1]], 3);
    if (!smooth && def.pts.length > 2) {
      pts = [];
      for (let i = 0; i < def.pts.length - 1; i++) {
        const seg = catmullRom([def.pts[i], def.pts[i + 1]], 3);
        if (i > 0) seg.shift();
        pts.push(...seg);
      }
    }
    pts = resample(pts, SAMPLE_STEP);
    if (def.type === 'track') {
      tracks.push(pts);
      continue;
    }
    // tunnel sample range
    const tun = new Uint8Array(pts.length);
    if (def.tunnel) {
      const near = (p: Vec2) => {
        let bi = 0, bd = 1e9;
        pts.forEach((q, i) => {
          const d = dist2(p.x, p.z, q.x, q.z);
          if (d < bd) { bd = d; bi = i; }
        });
        return bi;
      };
      const k0 = near(def.pts[def.tunnel[0]]), k1 = near(def.pts[def.tunnel[1]]);
      for (let i = k0; i <= k1; i++) tun[i] = 1;
    }
    if (def.viaduct) {
      const near = (p: Vec2) => {
        let bi = 0, bd = 1e9;
        pts.forEach((q, i) => {
          const d = dist2(p.x, p.z, q.x, q.z);
          if (d < bd) { bd = d; bi = i; }
        });
        return bi;
      };
      const k0 = near(def.pts[def.viaduct[0]]), k1 = near(def.pts[def.viaduct[1]]);
      for (let i = k0; i <= k1; i++) tun[i] = 2;
    }
    // 2. clip at water unless bridge
    const pieces: { p: Vec2[]; t: number[] }[] = [];
    if (def.bridge || def.viaduct) pieces.push({ p: pts, t: Array.from(tun) });
    else {
      let cur: Vec2[] = [], curT: number[] = [];
      const flush = () => {
        if (cur.length >= 5) pieces.push({ p: cur, t: curT });
        cur = [];
        curT = [];
      };
      pts.forEach((p, i) => {
        if (heightAt(p.x, p.z) < 0.4 && !tun[i]) flush();
        else {
          cur.push(p);
          curT.push(tun[i]);
        }
      });
      flush();
    }
    for (const piece of pieces) {
      const x = piece.p.map((p) => p.x), z = piece.p.map((p) => p.z);
      const cum = [0];
      for (let i = 1; i < x.length; i++) cum.push(cum[i - 1] + dist2(x[i - 1], z[i - 1], x[i], z[i]));
      let rampY: number[] | null = null;
      if (def.ramp) {
        const y0 = def.ramp[0] ?? heightAt(x[0], z[0]), y1 = def.ramp[1] ?? heightAt(x[x.length - 1], z[z.length - 1]);
        const L = cum[cum.length - 1];
        rampY = cum.map((c) => lerp(y0, y1, c / L));
      }
      polys.push({ def, x, z, cum, tunnel: Uint8Array.from(piece.t), splits: [], rampY });
    }
  }

  // 3. intersections
  const CELL = 32;
  const grid = new Map<number, number[]>(); // cell → [poly, seg, poly, seg...]
  const key = (cx: number, cz: number) => (cx + 512) * 4096 + (cz + 512);
  polys.forEach((p, pi) => {
    for (let i = 0; i < p.x.length - 1; i++) {
      const x0 = Math.floor(Math.min(p.x[i], p.x[i + 1]) / CELL), x1 = Math.floor(Math.max(p.x[i], p.x[i + 1]) / CELL);
      const z0 = Math.floor(Math.min(p.z[i], p.z[i + 1]) / CELL), z1 = Math.floor(Math.max(p.z[i], p.z[i + 1]) / CELL);
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz);
          let a = grid.get(k);
          if (!a) grid.set(k, (a = []));
          a.push(pi, i);
        }
    }
  });

  const nodes: RoadNode[] = [];
  const findNode = (x: number, z: number, r: number): number => {
    let best = -1, bd = r;
    for (const n of nodes) {
      const d = dist2(x, z, n.x, n.z);
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  };
  const getNode = (x: number, z: number, r = 12): number => {
    const f = findNode(x, z, r);
    if (f >= 0) return f;
    nodes.push({ id: nodes.length, x, z, y: 0, edges: [], signal: false });
    return nodes.length - 1;
  };

  const tu = [0, 0];
  const seen = new Set<string>();
  polys.forEach((p, pi) => {
    for (let i = 0; i < p.x.length - 1; i++) {
      const cx = Math.floor(((p.x[i] + p.x[i + 1]) / 2) / CELL), cz = Math.floor(((p.z[i] + p.z[i + 1]) / 2) / CELL);
      for (let ox = -1; ox <= 1; ox++)
        for (let oz = -1; oz <= 1; oz++) {
          const a = grid.get(key(cx + ox, cz + oz));
          if (!a) continue;
          for (let k = 0; k < a.length; k += 2) {
            const pj = a[k], j = a[k + 1];
            if (pj <= pi) continue;
            const q = polys[pj];
            const id = pi + ':' + i + ':' + pj + ':' + j;
            if (seen.has(id)) continue;
            seen.add(id);
            if (segIntersect(p.x[i], p.z[i], p.x[i + 1], p.z[i + 1], q.x[j], q.z[j], q.x[j + 1], q.z[j + 1], tu)) {
              // a tunnel never intersects surface roads
              if (p.tunnel[i] || q.tunnel[j]) continue;
              const x = lerp(p.x[i], p.x[i + 1], tu[0]), z = lerp(p.z[i], p.z[i + 1], tu[0]);
              const node = getNode(x, z);
              p.splits.push({ s: lerp(p.cum[i], p.cum[i + 1], tu[0]), node });
              q.splits.push({ s: lerp(q.cum[j], q.cum[j + 1], tu[1]), node });
            }
          }
        }
    }
  });

  // endpoints: snap to existing node, else to nearest other road (T junction), else new node
  const tt = [0];
  polys.forEach((p, pi) => {
    for (const end of [0, p.x.length - 1]) {
      const ex = p.x[end], ez = p.z[end];
      const s = p.cum[end];
      let node = findNode(ex, ez, 15);
      if (node < 0) {
        let bd = 15, bq = -1, bj = 0, bt = 0;
        const cx = Math.floor(ex / CELL), cz = Math.floor(ez / CELL);
        for (let ox = -1; ox <= 1; ox++)
          for (let oz = -1; oz <= 1; oz++) {
            const a = grid.get(key(cx + ox, cz + oz));
            if (!a) continue;
            for (let k = 0; k < a.length; k += 2) {
              const pj = a[k], j = a[k + 1];
              if (pj === pi) continue;
              const q = polys[pj];
              if (q.tunnel[j]) continue;
              const d = distToSegment(ex, ez, q.x[j], q.z[j], q.x[j + 1], q.z[j + 1], tt);
              if (d < bd) { bd = d; bq = pj; bj = j; bt = tt[0]; }
            }
          }
        if (bq >= 0) {
          const q = polys[bq];
          node = getNode(lerp(q.x[bj], q.x[bj + 1], bt), lerp(q.z[bj], q.z[bj + 1], bt), 6);
          q.splits.push({ s: lerp(q.cum[bj], q.cum[bj + 1], bt), node });
        } else node = getNode(ex, ez, 6);
      } else {
        // make sure the road that owns this node is split there as well
        const n = nodes[node];
        polys.forEach((q, qi) => {
          if (qi === pi) return;
          for (let j = 0; j < q.x.length - 1; j++) {
            if (q.tunnel[j]) continue;
            if (Math.abs(q.x[j] - n.x) > 30 || Math.abs(q.z[j] - n.z) > 30) continue;
            const d = distToSegment(n.x, n.z, q.x[j], q.z[j], q.x[j + 1], q.z[j + 1], tt);
            if (d < 7) {
              const sq = lerp(q.cum[j], q.cum[j + 1], tt[0]);
              if (!q.splits.some((sp) => sp.node === node)) q.splits.push({ s: sq, node });
            }
          }
        });
      }
      p.splits.push({ s, node });
    }
  });

  // 4. edges
  const edges: RoadEdge[] = [];
  const edgeRamp: (number[] | null)[] = [];
  for (const p of polys) {
    p.splits.sort((a, b) => a.s - b.s);
    const spec = ROAD_SPECS[p.def.type];
    for (let k = 0; k < p.splits.length - 1; k++) {
      const A = p.splits[k], B = p.splits[k + 1];
      if (A.node === B.node || B.s - A.s < 4) continue;
      const na = nodes[A.node], nb = nodes[B.node];
      const xs: number[] = [na.x], zs: number[] = [na.z], fl: number[] = [0];
      const L = p.cum[p.cum.length - 1];
      const rampAt = (sv: number) => (p.rampY ? lerp(p.rampY[0], p.rampY[p.rampY.length - 1], sv / L) : 0);
      const ry: number[] = [rampAt(A.s)];
      for (let i = 0; i < p.x.length; i++) {
        if (p.cum[i] > A.s + 2.5 && p.cum[i] < B.s - 2.5) {
          xs.push(p.x[i]);
          zs.push(p.z[i]);
          fl.push(p.tunnel[i] === 1 ? 2 : p.tunnel[i] === 2 ? 3 : 0);
          ry.push(rampAt(p.cum[i]));
        }
      }
      xs.push(nb.x);
      zs.push(nb.z);
      fl.push(0);
      ry.push(rampAt(B.s));
      const n = xs.length;
      const e: RoadEdge = {
        id: edges.length, a: A.node, b: B.node, type: p.def.type, name: p.def.name,
        width: spec.width, sidewalk: spec.sidewalk, lanes: spec.lanes, speed: spec.speed,
        n, px: Float32Array.from(xs), py: new Float32Array(n), pz: Float32Array.from(zs), cum: new Float32Array(n), length: 0,
        flag: Uint8Array.from(fl), tram: !!p.def.tram, noBuildings: !!p.def.noBuildings, blend: !!p.rampY,
      };
      for (let i = 1; i < n; i++) e.cum[i] = e.cum[i - 1] + dist2(e.px[i - 1], e.pz[i - 1], e.px[i], e.pz[i]);
      e.length = e.cum[n - 1];
      // skip exact duplicates
      if (edges.some((o) => ((o.a === e.a && o.b === e.b) || (o.a === e.b && o.b === e.a)) && Math.abs(o.length - e.length) < 12)) continue;
      edges.push(e);
      edgeRamp.push(p.rampY ? ry : null);
      na.edges.push(e.id);
      nb.edges.push(e.id);
    }
  }

  // 5. height profile targets
  const target: Float32Array[] = [];
  const stiff: Float32Array[] = [];
  for (const e of edges) {
    const t = new Float32Array(e.n), st = new Float32Array(e.n);
    const bridgeable = defs.find((d) => d.name === e.name)?.bridge;
    const ramp = edgeRamp[e.id];
    const viaduct = new Uint8Array(e.n);
    for (let i = 0; i < e.n; i++) {
      const h = heightAt(e.px[i], e.pz[i]);
      t[i] = h;
      st[i] = 0.03;
      if (ramp) {
        t[i] = ramp[i];
        st[i] = 0.35;
        continue;
      }
      if (e.flag[i] === 2) continue;
      if (e.flag[i] === 3) {
        e.flag[i] = 1;
        t[i] = h + 6.8;
        st[i] = 0.6;
        viaduct[i] = 1;
      } else if (bridgeable && h < 1.5) {
        e.flag[i] = 1;
      }
    }
    // bridge decks over water: interpolate bank heights
    for (let i = 0; i < e.n; i++) {
      if (e.flag[i] !== 1 || st[i] > 0.5) continue;
      let j = i;
      while (j < e.n && e.flag[j] === 1 && st[j] < 0.5) j++;
      const h0 = Math.max(4.6, t[Math.max(0, i - 4)]), h1 = Math.max(4.6, t[Math.min(e.n - 1, j + 3)]);
      for (let k = Math.max(1, i - 4); k < i; k++) { t[k] = h0; st[k] = 0.3; }
      for (let k = j; k < Math.min(e.n - 1, j + 4); k++) { t[k] = h1; st[k] = 0.3; }
      for (let k = i; k < j; k++) {
        const f = (k - i + 1) / (j - i + 1);
        t[k] = lerp(h0, h1, f) + dsin(f * Math.PI) * Math.min(1.2, (j - i) * 0.05);
        st[k] = 0.6;
      }
      i = j;
    }
    // tunnels: straight ramp that starts well before the portal so the approach is a cutting
    for (let i = 0; i < e.n; i++) {
      if (e.flag[i] !== 2) continue;
      let j = i;
      while (j < e.n && e.flag[j] === 2) j++;
      const i0 = Math.max(0, i - 9), j1 = Math.min(e.n - 1, j + 5);
      const h0 = t[i0], h1 = t[j1];
      for (let k = i0 + 1; k < j1; k++) {
        t[k] = lerp(h0, h1, (k - i0) / (j1 - i0));
        st[k] = 0.5;
      }
      i = j;
    }
    // ramps up to rail bridges
    for (let i = 0; i < e.n; i++) {
      if (!viaduct[i]) continue;
      let j = i;
      while (j < e.n && viaduct[j]) j++;
      const R = 9;
      for (let k = 1; k <= R; k++) {
        const f = 1 - k / (R + 1);
        const up = 6.8 * f * f * (3 - 2 * f);
        if (i - k > 0 && e.flag[i - k] === 0) { t[i - k] += up; st[i - k] = 0.35; }
        if (j - 1 + k < e.n - 1 && e.flag[j - 1 + k] === 0) { t[j - 1 + k] += up; st[j - 1 + k] = 0.35; }
      }
      i = j;
    }
    target.push(t);
    stiff.push(st);
    e.py.set(t);
  }
  for (const n of nodes) n.y = heightAt(n.x, n.z);
  // tunnel portals bias: make samples just outside tunnels follow the ramp too (handled by relaxation)

  // 6. relaxation (Jacobi-ish, in place)
  for (let it = 0; it < 260; it++) {
    for (const n of nodes) {
      if (!n.edges.length) continue;
      let sum = 0;
      for (const ei of n.edges) {
        const e = edges[ei];
        sum += e.a === n.id ? e.py[1] : e.py[e.n - 2];
      }
      const avg = sum / n.edges.length;
      let base = Math.max(heightAt(n.x, n.z), 1.2), k = 0.03;
      for (const ei of n.edges) {
        const r = edgeRamp[ei];
        if (r) {
          base = edges[ei].a === n.id ? r[0] : r[r.length - 1];
          k = 0.4;
        }
      }
      n.y = lerp(avg, base, k);
    }
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei], t = target[ei], st = stiff[ei];
      e.py[0] = nodes[e.a].y;
      e.py[e.n - 1] = nodes[e.b].y;
      for (let i = 1; i < e.n - 1; i++) {
        e.py[i] = lerp((e.py[i - 1] + e.py[i + 1]) * 0.5, t[i], st[i]);
      }
    }
  }
  for (const e of edges) {
    e.py[0] = nodes[e.a].y;
    e.py[e.n - 1] = nodes[e.b].y;
  }

  // 7. traffic signals at bigger junctions
  for (const n of nodes) {
    if (n.edges.length < 3) continue;
    let mains = 0, hw = 0;
    for (const ei of n.edges) {
      if (edges[ei].type === 'main') mains++;
      if (edges[ei].type === 'highway') hw++;
    }
    n.signal = hw === 0 && (mains >= 3 || (mains >= 2 && n.edges.length >= 4));
  }
  return { nodes, edges, tracks };
}

// ---------------------------------------------------------------- queries
export interface EdgePos {
  x: number;
  y: number;
  z: number;
  /** unit tangent a→b */
  tx: number;
  tz: number;
  flag: number;
}
export function edgePos(e: RoadEdge, s: number, out: EdgePos): EdgePos {
  s = clamp(s, 0, e.length);
  let lo = 0, hi = e.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (e.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = e.cum[hi] - e.cum[lo];
  const t = seg > 0 ? (s - e.cum[lo]) / seg : 0;
  out.x = lerp(e.px[lo], e.px[hi], t);
  out.y = lerp(e.py[lo], e.py[hi], t);
  out.z = lerp(e.pz[lo], e.pz[hi], t);
  const dx = e.px[hi] - e.px[lo], dz = e.pz[hi] - e.pz[lo];
  const l = Math.sqrt(dx * dx + dz * dz) || 1;
  out.tx = dx / l;
  out.tz = dz / l;
  out.flag = e.flag[t < 0.5 ? lo : hi];
  return out;
}

/** Spatial index over road segments for nearest-road queries. */
export class RoadIndex {
  private cell = 32;
  private grid = new Map<number, Int32Array>();
  constructor(public graph: RoadGraph) {
    const tmp = new Map<number, number[]>();
    for (const e of graph.edges) {
      for (let i = 0; i < e.n - 1; i++) {
        const pad = 2;
        const x0 = Math.floor((Math.min(e.px[i], e.px[i + 1]) - pad) / this.cell), x1 = Math.floor((Math.max(e.px[i], e.px[i + 1]) + pad) / this.cell);
        const z0 = Math.floor((Math.min(e.pz[i], e.pz[i + 1]) - pad) / this.cell), z1 = Math.floor((Math.max(e.pz[i], e.pz[i + 1]) + pad) / this.cell);
        for (let cx = x0; cx <= x1; cx++)
          for (let cz = z0; cz <= z1; cz++) {
            const k = (cx + 512) * 4096 + (cz + 512);
            let a = tmp.get(k);
            if (!a) tmp.set(k, (a = []));
            a.push(e.id, i);
          }
      }
    }
    for (const [k, a] of tmp) this.grid.set(k, Int32Array.from(a));
  }
  private _t = [0];
  /** Nearest road within maxDist. Returns null if none. */
  nearest(x: number, z: number, maxDist: number, out: NearestRoad, filter?: (e: RoadEdge) => boolean): NearestRoad | null {
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = maxDist, found = false;
    for (let ox = -r; ox <= r; ox++)
      for (let oz = -r; oz <= r; oz++) {
        const a = this.grid.get((cx + ox + 512) * 4096 + (cz + oz + 512));
        if (!a) continue;
        for (let k = 0; k < a.length; k += 2) {
          const e = this.graph.edges[a[k]], i = a[k + 1];
          if (filter && !filter(e)) continue;
          const d = distToSegment(x, z, e.px[i], e.pz[i], e.px[i + 1], e.pz[i + 1], this._t);
          if (d < best) {
            best = d;
            found = true;
            const t = this._t[0];
            out.edge = e;
            out.seg = i;
            out.t = t;
            out.s = lerp(e.cum[i], e.cum[i + 1], t);
            out.dist = d;
            out.y = lerp(e.py[i], e.py[i + 1], t);
            const dx = e.px[i + 1] - e.px[i], dz = e.pz[i + 1] - e.pz[i];
            // side: +1 = right of a→b direction
            out.side = (x - e.px[i]) * -dz + (z - e.pz[i]) * dx > 0 ? 1 : -1;
          }
        }
      }
    return found ? out : null;
  }
}
export interface NearestRoad {
  edge: RoadEdge;
  seg: number;
  t: number;
  s: number;
  dist: number;
  y: number;
  side: number;
}
export function makeNearest(): NearestRoad {
  return { edge: null as unknown as RoadEdge, seg: 0, t: 0, s: 0, dist: 0, y: 0, side: 1 };
}

/** Dijkstra shortest path (by travel time) between two nodes. Returns node id list. */
export function findRoute(graph: RoadGraph, from: number, to: number): number[] {
  const N = graph.nodes.length;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  dist[from] = 0;
  // simple binary heap
  const heap: number[] = [from];
  const hd: number[] = [0];
  const push = (n: number, d: number) => {
    let i = heap.length;
    heap.push(n);
    hd.push(d);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hd[p] <= d) break;
      heap[i] = heap[p]; hd[i] = hd[p];
      i = p;
    }
    heap[i] = n; hd[i] = d;
  };
  const pop = (): number => {
    const top = heap[0];
    const ln = heap.pop()!, ld = hd.pop()!;
    if (heap.length) {
      let i = 0;
      const len = heap.length;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= len) break;
        if (c + 1 < len && hd[c + 1] < hd[c]) c++;
        if (hd[c] >= ld) break;
        heap[i] = heap[c]; hd[i] = hd[c];
        i = c;
      }
      heap[i] = ln; hd[i] = ld;
    }
    return top;
  };
  while (heap.length) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === to) break;
    for (const ei of graph.nodes[u].edges) {
      const e = graph.edges[ei];
      const v = e.a === u ? e.b : e.a;
      if (done[v]) continue;
      const nd = dist[u] + e.length / Math.max(4, e.speed);
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        push(v, nd);
      }
    }
  }
  if (prev[to] < 0 && to !== from) return [];
  const path: number[] = [];
  for (let n = to; n >= 0; n = prev[n]) {
    path.push(n);
    if (n === from) break;
  }
  return path.reverse();
}
