// Deterministic placement of buildings, trees, street furniture and parking along the road graph.
import { Rng, clamp, datan2, dcos, dist2, dsin, hash2, lerp, noise2 } from '../math';
import { PASS_SADDLE, UETLIBERG_TOP, VILLAGE_CENTER, Zone, lakeSd, riverDist } from './layout';
import { EdgePos, RoadEdge, edgePos, makeNearest } from './roads';
import { Collider, boxCollider, circleCollider } from './colliders';
import type { World } from './world';

export const enum BKind {
  OldTown = 0,
  Downtown = 1,
  Office = 2,
  Tower = 3,
  Apartment = 4,
  Villa = 5,
  Hall = 6,
  Chalet = 7,
  Farm = 8,
  Barn = 9,
  Station = 10,
  Church = 11,
  Civic = 12, // opera / university / hospital style representative building
  Lookout = 13,
  Hospiz = 14,
  Kiosk = 15,
}

export interface Building {
  id: number;
  kind: BKind;
  x: number;
  z: number;
  /** yaw; local +Z faces the street */
  rot: number;
  w: number; // along local x
  d: number; // along local z
  /** lowest terrain point under the footprint (walls start here) */
  y0: number;
  /** entrance floor level */
  yF: number;
  /** eaves height above yF */
  h: number;
  floors: number;
  seed: number;
  zone: Zone;
  /** landmark variant id */
  variant: number;
  name?: string;
}

export interface TreeSpec { x: number; z: number; y: number; s: number; type: number; /* 0 conifer, 1 deciduous, 2 poplar/plane street tree */ }
export interface LampSpec { x: number; z: number; y: number; rot: number; type: number; /* 0 street, 1 old-town lantern, 2 highway */ }
export interface ParkSpot { x: number; z: number; y: number; yaw: number; lot: boolean }
export interface SignalSpec { node: number; x: number; z: number; y: number; rot: number; edge: number; phase: number }
export interface PedPath { edge: number; side: number }

export interface CityData {
  buildings: Building[];
  trees: TreeSpec[];
  lamps: LampSpec[];
  parking: ParkSpot[];
  signals: SignalSpec[];
}

interface LotStyle {
  kind: BKind;
  front: [number, number];
  depth: [number, number];
  setback: [number, number];
  gap: [number, number];
  floors: [number, number];
  floorH: number;
  prob: number;
}
const STYLES: Partial<Record<Zone, LotStyle>> = {
  [Zone.OldTown]: { kind: BKind.OldTown, front: [7, 12.5], depth: [11, 15], setback: [0.2, 0.5], gap: [0, 0], floors: [4, 5], floorH: 3.0, prob: 1 },
  [Zone.Downtown]: { kind: BKind.Downtown, front: [15, 26], depth: [14, 18], setback: [0.3, 0.6], gap: [0, 0], floors: [5, 7], floorH: 3.4, prob: 1 },
  [Zone.Business]: { kind: BKind.Office, front: [26, 44], depth: [22, 32], setback: [3, 5], gap: [7, 13], floors: [6, 13], floorH: 3.6, prob: 1 },
  [Zone.Residential]: { kind: BKind.Apartment, front: [16, 27], depth: [11, 14], setback: [3.5, 6], gap: [5, 9], floors: [3, 5], floorH: 2.9, prob: 1 },
  [Zone.Hillside]: { kind: BKind.Villa, front: [11, 16], depth: [9, 12], setback: [6, 9], gap: [9, 16], floors: [2, 3], floorH: 2.9, prob: 0.92 },
  [Zone.Industrial]: { kind: BKind.Hall, front: [30, 58], depth: [24, 38], setback: [7, 10], gap: [10, 18], floors: [2, 3], floorH: 4.6, prob: 1 },
  [Zone.Village]: { kind: BKind.Chalet, front: [9.5, 14], depth: [8, 11], setback: [2.5, 6], gap: [5, 11], floors: [2, 3], floorH: 2.7, prob: 0.95 },
  [Zone.Rural]: { kind: BKind.Farm, front: [15, 21], depth: [10, 12.5], setback: [8, 14], gap: [120, 260], floors: [2, 2], floorH: 2.8, prob: 0.55 },
};

function corners(x: number, z: number, hw: number, hd: number, sin: number, cos: number, out: number[]): void {
  // local x axis = (cos, -sin), local z axis = (sin, cos)
  const ax = cos * hw, az = -sin * hw, bx = sin * hd, bz = cos * hd;
  out[0] = x - ax - bx; out[1] = z - az - bz;
  out[2] = x + ax - bx; out[3] = z + az - bz;
  out[4] = x + ax + bx; out[5] = z + az + bz;
  out[6] = x - ax + bx; out[7] = z - az + bz;
}
function obbOverlap(a: number[], b: number[]): boolean {
  for (let pass = 0; pass < 2; pass++) {
    const p = pass === 0 ? a : b;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      const nx = p[j * 2 + 1] - p[i * 2 + 1], nz = -(p[j * 2] - p[i * 2]);
      let minA = 1e9, maxA = -1e9, minB = 1e9, maxB = -1e9;
      for (let k = 0; k < 4; k++) {
        const da = a[k * 2] * nx + a[k * 2 + 1] * nz;
        if (da < minA) minA = da;
        if (da > maxA) maxA = da;
        const db = b[k * 2] * nx + b[k * 2 + 1] * nz;
        if (db < minB) minB = db;
        if (db > maxB) maxB = db;
      }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

export function buildCity(w: World): CityData {
  const buildings: Building[] = [];
  const trees: TreeSpec[] = [];
  const lamps: LampSpec[] = [];
  const parking: ParkSpot[] = [];
  const signals: SignalSpec[] = [];
  const g = w.roads;
  const near = makeNearest();
  const tmpC: Collider[] = [];
  const ca = new Array<number>(8), cb = new Array<number>(8);
  const ep: EdgePos = { x: 0, y: 0, z: 0, tx: 0, tz: 0, flag: 0 };

  const roadClear = (x: number, z: number, pad: number, own?: RoadEdge): boolean => {
    const n = w.roadIndex.nearest(x, z, 26, near);
    if (!n) return true;
    if (own && n.edge === own) return true;
    return n.dist >= n.edge.width / 2 + n.edge.sidewalk + pad;
  };
  const footprintFree = (x: number, z: number, hw: number, hd: number, rot: number, pad: number): boolean => {
    const s = dsin(rot), c = dcos(rot);
    corners(x, z, hw + pad, hd + pad, s, c, ca);
    const r = Math.sqrt(hw * hw + hd * hd) + pad + 2;
    w.colliders.query(x, z, r, tmpC);
    for (const o of tmpC) {
      if (o.kind === 1) {
        if (dist2(o.x, o.z, x, z) < r) {
          // precise: point in expanded box
          const dx = o.x - x, dz = o.z - z;
          const lx = dx * c - dz * s, lz = dx * s + dz * c;
          if (Math.abs(lx) < hw + pad + o.hx && Math.abs(lz) < hd + pad + o.hx) return false;
        }
        continue;
      }
      corners(o.x, o.z, o.hx, o.hz, o.sin, o.cos, cb);
      if (obbOverlap(ca, cb)) return false;
    }
    return true;
  };
  const addBuilding = (b: Omit<Building, 'id' | 'y0' | 'yF'> & { yF?: number }): Building => {
    const s = dsin(b.rot), c = dcos(b.rot);
    corners(b.x, b.z, b.w / 2, b.d / 2, s, c, ca);
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < 4; i++) {
      const h = w.terrainAt(ca[i * 2], ca[i * 2 + 1]);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    // entrance level = terrain at the middle of the street-facing side
    const fx = b.x + s * b.d / 2, fz = b.z + c * b.d / 2;
    const yF = b.yF ?? Math.max(w.terrainAt(fx, fz), lerp(lo, hi, 0.5)) + 0.15;
    const bd: Building = { ...b, id: buildings.length, y0: lo - 0.6, yF };
    buildings.push(bd);
    const col = boxCollider(b.x, b.z, b.w / 2, b.d / 2, b.rot, lo - 2, yF + b.h + 12);
    col.sin = s;
    col.cos = c;
    w.colliders.add(col);
    return bd;
  };

  // ------------------------------------------------------------ landmarks (reserved first)
  const LM: { kind: BKind; name: string; x: number; z: number; w: number; d: number; rot: number; h: number; floors: number; variant: number }[] = [
    { kind: BKind.Station, name: 'Hauptbahnhof', x: -268, z: -379, w: 222, d: 74, rot: 0, h: 21, floors: 2, variant: 0 },
    { kind: BKind.Church, name: 'Grossmünster', x: 72, z: 190, w: 22, d: 44, rot: -Math.PI / 2, h: 19, floors: 1, variant: 0 },
    { kind: BKind.Church, name: 'Fraumünster', x: -72, z: 210, w: 17, d: 38, rot: Math.PI / 2, h: 17, floors: 1, variant: 1 },
    { kind: BKind.Church, name: 'St. Peter', x: -138, z: 138, w: 16, d: 30, rot: Math.PI / 2, h: 14, floors: 1, variant: 2 },
    { kind: BKind.Civic, name: 'Opernhaus', x: 338, z: 362, w: 46, d: 34, rot: Math.PI, h: 19, floors: 3, variant: 0 },
    { kind: BKind.Civic, name: 'Hochschule', x: 396, z: -50, w: 96, d: 38, rot: -Math.PI / 2, h: 22, floors: 4, variant: 1 },
    { kind: BKind.Civic, name: 'Universitätsspital', x: 312, z: -196, w: 62, d: 30, rot: -Math.PI / 2, h: 24, floors: 6, variant: 2 },
    { kind: BKind.Tower, name: 'Prime-Turm', x: -548, z: -494, w: 34, d: 30, rot: 0, h: 126, floors: 36, variant: 0 },
    { kind: BKind.Tower, name: 'Mobimo-Turm', x: -345, z: -494, w: 26, d: 26, rot: 0.2, h: 81, floors: 24, variant: 1 },
    { kind: BKind.Tower, name: 'Hardturm', x: -760, z: -655, w: 28, d: 24, rot: 0.1, h: 64, floors: 19, variant: 2 },
    { kind: BKind.Church, name: 'Dorfkirche', x: VILLAGE_CENTER.x + 34, z: VILLAGE_CENTER.z + 44, w: 11, d: 22, rot: Math.PI / 2, h: 9, floors: 1, variant: 3 },
    { kind: BKind.Lookout, name: 'Aussichtsturm Uetliberg', x: UETLIBERG_TOP.x - 6, z: UETLIBERG_TOP.z - 16, w: 7, d: 7, rot: 0, h: 30, floors: 1, variant: 0 },
    { kind: BKind.Hospiz, name: 'Hospiz Passhöhe', x: PASS_SADDLE.x + 6, z: PASS_SADDLE.z - 24, w: 20, d: 11, rot: 0.15, h: 6.4, floors: 2, variant: 0 },
  ];
  for (const l of LM) addBuilding({ kind: l.kind, x: l.x, z: l.z, rot: l.rot, w: l.w, d: l.d, h: l.h, floors: l.floors, seed: (l.x * 31 + l.z * 17) | 0, zone: w.zoneAt(l.x, l.z), variant: l.variant, name: l.name });

  // ------------------------------------------------------------ lots along roads
  const order = ['main', 'street', 'alley', 'rural'];
  const edgesSorted = g.edges.filter((e) => !e.noBuildings && e.type !== 'highway').sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.id - b.id);
  for (const e of edgesSorted) {
    for (const side of [1, -1]) {
      const rng = new Rng(e.id * 7919 + (side > 0 ? 13 : 71));
      const endMargin = 7;
      let s = endMargin + rng.range(0, 3);
      let guard = 0;
      while (s < e.length - endMargin - 6 && guard++ < 400) {
        edgePos(e, s, ep);
        const zone0 = w.zoneAt(ep.x - ep.tz * side * (e.width / 2 + e.sidewalk + 8), ep.z + ep.tx * side * (e.width / 2 + e.sidewalk + 8));
        const st = STYLES[zone0];
        if (!st || ep.flag) {
          s += 6;
          continue;
        }
        let front = rng.range(st.front[0], st.front[1]);
        const depth = rng.range(st.depth[0], st.depth[1]);
        const setback = rng.range(st.setback[0], st.setback[1]);
        if (s + front > e.length - endMargin) front = e.length - endMargin - s;
        if (front < st.front[0] * 0.8 || !rng.chance(st.prob)) {
          s += rng.range(6, 14);
          continue;
        }
        edgePos(e, s + front / 2, ep);
        if (ep.flag) {
          s += 6;
          continue;
        }
        // right vector for direction (tx,tz) is (-tz, tx)
        const rx = -ep.tz * side, rz = ep.tx * side;
        const off = e.width / 2 + e.sidewalk + setback + depth / 2;
        const cx = ep.x + rx * off, cz = ep.z + rz * off;
        const rot = datan2(-rx, -rz);
        const sn = dsin(rot), cs = dcos(rot);
        corners(cx, cz, front / 2, depth / 2, sn, cs, ca);
        let ok = w.inBounds(cx, cz, 30);
        let lo = 1e9, hi = -1e9;
        for (let i = 0; i < 4 && ok; i++) {
          const px = ca[i * 2], pz = ca[i * 2 + 1];
          const h = w.terrainAt(px, pz);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
          if (h < 1.0) ok = false;
          const zn = w.zoneAt(px, pz);
          if (zn === Zone.Water || zn === Zone.Park || zn === Zone.Station || zn === Zone.Forest || zn === Zone.Alpine) ok = false;
          if (ok && !roadClear(px, pz, 0.3)) ok = false;
        }
        if (ok && hi - lo > Math.max(4.5, depth * 0.42)) ok = false;
        // mid points of the far side + centre against other roads
        if (ok && (!roadClear(cx, cz, 0.3) || !roadClear((ca[0] + ca[2]) / 2, (ca[1] + ca[3]) / 2, 0.3) || !roadClear((ca[4] + ca[6]) / 2, (ca[5] + ca[7]) / 2, 0.3, e))) ok = false;
        if (ok && (lakeSd(cx, cz) < depth / 2 + 4 || riverDist(cx, cz) < 24 + depth / 2 + 3)) ok = false;
        if (ok && !footprintFree(cx, cz, front / 2, depth / 2, rot, st.gap[1] > 0 ? 1.2 : -0.12)) ok = false;
        if (!ok) {
          s += 4;
          continue;
        }
        let kind = st.kind;
        let floors = rng.int(st.floors[0], st.floors[1]);
        let floorH = st.floorH;
        let variant = rng.int(0, 7);
        if (kind === BKind.Office && rng.chance(0.14) && front > 28) {
          kind = BKind.Tower;
          floors = rng.int(15, 22);
          variant = 3 + rng.int(0, 2);
        }
        if (kind === BKind.Farm && rng.chance(0.4)) kind = BKind.Barn;
        if (kind === BKind.Hall) floorH = rng.range(4.2, 6.5);
        addBuilding({ kind, x: cx, z: cz, rot, w: front, d: depth, h: floors * floorH + (kind === BKind.Downtown || kind === BKind.OldTown ? 1.0 : 0.4), floors, seed: (rng.next() * 1e9) | 0, zone: zone0, variant });
        s += front + rng.range(st.gap[0], st.gap[1]);
      }
    }
  }

  // ------------------------------------------------------------ lamps, street trees, parking, signals
  for (const e of g.edges) {
    if (e.type === 'rural') continue;
    const rng = new Rng(e.id * 104729 + 5);
    const hasWalk = e.sidewalk > 0;
    const spacing = e.type === 'highway' ? 46 : e.type === 'alley' ? 34 : 30;
    let k = 0;
    for (let s = spacing * 0.5; s < e.length - 6; s += spacing, k++) {
      edgePos(e, s, ep);
      if (ep.flag === 2) continue;
      const side = e.type === 'highway' ? 0 : k % 2 === 0 ? 1 : -1;
      const off = e.type === 'highway' ? 0 : hasWalk ? e.width / 2 + 0.7 : e.width / 2 - 0.35;
      const x = ep.x - ep.tz * side * off, z = ep.z + ep.tx * side * off;
      const rot = datan2(ep.tz * side, -ep.tx * side);
      lamps.push({ x, z, y: ep.y + (hasWalk ? 0.14 : 0), rot: e.type === 'highway' ? datan2(ep.tx, ep.tz) : rot, type: e.type === 'highway' ? 2 : e.type === 'alley' ? 1 : 0 });
      if (e.type !== 'alley') w.colliders.add(circleCollider(x, z, 0.16, ep.y - 1, ep.y + 7, true));
    }
    // street trees on main roads and residential streets
    const zone = w.zoneAt(e.px[e.n >> 1], e.pz[e.n >> 1]);
    const wantTrees = hasWalk && ((e.type === 'main' && zone !== Zone.Industrial) || zone === Zone.Residential || zone === Zone.Hillside);
    if (wantTrees) {
      for (let s = 12; s < e.length - 10; s += 15) {
        for (const side of [1, -1]) {
          if (rng.chance(0.22)) continue;
          edgePos(e, s + (side > 0 ? 0 : 7), ep);
          if (ep.flag) continue;
          const off = e.width / 2 + e.sidewalk - 0.9;
          const x = ep.x - ep.tz * side * off, z = ep.z + ep.tx * side * off;
          // keep junction corners clear
          const n = w.roadIndex.nearest(x, z, 14, near, (o) => o !== e);
          if (n && n.dist < n.edge.width / 2 + n.edge.sidewalk + 1) continue;
          trees.push({ x, z, y: w.terrainAt(x, z) + 0.12, s: rng.range(0.8, 1.1), type: 2 });
          w.colliders.add(circleCollider(x, z, 0.28, ep.y - 1, ep.y + 8));
        }
      }
    }
    // roadside parking on main roads (parking strip between lane and kerb)
    if (e.type === 'main' && !e.tram) {
      for (let s = 16; s < e.length - 18; s += 6.2) {
        for (const side of [1, -1]) {
          if (!rng.chance(0.3)) continue;
          edgePos(e, s, ep);
          if (ep.flag) continue;
          const off = e.width / 2 - 1.15;
          const x = ep.x - ep.tz * side * off, z = ep.z + ep.tx * side * off;
          parking.push({ x, z, y: ep.y, yaw: datan2(ep.tx * side, ep.tz * side), lot: false });
        }
      }
    }
  }
  // traffic signals
  for (const n of g.nodes) {
    if (!n.signal) continue;
    n.edges.forEach((ei, idx) => {
      const e = g.edges[ei];
      const fromA = e.a === n.id;
      const s = fromA ? Math.min(e.length * 0.4, 13) : Math.max(e.length * 0.6, e.length - 13);
      edgePos(e, s, ep);
      // direction of travel towards the node
      const dirx = fromA ? -ep.tx : ep.tx, dirz = fromA ? -ep.tz : ep.tz;
      const off = e.width / 2 + 0.8;
      const x = ep.x - dirz * off, z = ep.z + dirx * off;
      // phase group: edges roughly aligned N-S vs E-W
      const phase = Math.abs(dirx) > Math.abs(dirz) ? 0 : 1;
      signals.push({ node: n.id, x, z, y: ep.y + 0.14, rot: datan2(-dirx, -dirz), edge: ei, phase });
      w.colliders.add(circleCollider(x, z, 0.14, ep.y - 1, ep.y + 5, true));
      void idx;
    });
  }

  // ------------------------------------------------------------ parking lots at points of interest
  const lot = (cx: number, cz: number, yaw: number, cols: number, rows: number) => {
    const s = dsin(yaw), c = dcos(yaw);
    for (let r = 0; r < rows; r++)
      for (let i = 0; i < cols; i++) {
        const lx = (i - (cols - 1) / 2) * 2.9, lz = (r - (rows - 1) / 2) * 11;
        const x = cx + c * lx + s * lz, z = cz - s * lx + c * lz;
        if (w.terrainAt(x, z) < 1) continue;
        parking.push({ x, z, y: w.terrainAt(x, z), yaw: yaw + (r % 2 ? Math.PI : 0), lot: true });
      }
  };
  lot(-150, 340, Math.PI / 2, 6, 1); // Bürkliplatz
  lot(-130, -330, 0, 5, 1); // HB east
  lot(-770, -480, Math.PI / 2, 7, 1); // dealer
  lot(VILLAGE_CENTER.x - 30, VILLAGE_CENTER.z + 22, Math.PI / 2, 5, 1);
  lot(PASS_SADDLE.x - 22, PASS_SADDLE.z + 14, Math.PI / 2, 5, 1);
  lot(UETLIBERG_TOP.x + 14, UETLIBERG_TOP.z + 30, 0, 4, 1);

  // ------------------------------------------------------------ trees: parks, gardens, forests
  const treeOk = (x: number, z: number, pad: number): boolean => {
    if (w.terrainAt(x, z) < 1.2) return false;
    const n = w.roadIndex.nearest(x, z, 20, near);
    if (n && n.dist < n.edge.width / 2 + n.edge.sidewalk + pad) return false;
    w.colliders.query(x, z, 2.5, tmpC);
    for (const o of tmpC) {
      if (o.kind === 0) {
        const dx = x - o.x, dz = z - o.z;
        const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
        if (Math.abs(lx) < o.hx + 2.2 && Math.abs(lz) < o.hz + 2.2) return false;
      }
    }
    return true;
  };
  const STEP = 8;
  const half = w.half - 12;
  for (let gz = -half; gz < half; gz += STEP) {
    for (let gx0 = -half; gx0 < half; gx0 += STEP) {
      const ix = Math.round(gx0 / STEP), iz = Math.round(gz / STEP);
      const r1 = hash2(ix, iz, 901), r2 = hash2(ix, iz, 902), r3 = hash2(ix, iz, 903), r4 = hash2(ix, iz, 904);
      const x = gx0 + r1 * STEP, z = gz + r2 * STEP;
      const zone = w.zoneAt(x, z);
      let p = 0, type = 1, trunk = 0.3;
      switch (zone) {
        case Zone.Forest: {
          const h = w.terrainAt(x, z);
          const dens = 0.62 + 0.3 * noise2(x / 60, z / 60, 77);
          p = dens;
          // conifers dominate higher up and in the mountains
          const conifer = clamp((h - 40) / 120, 0.12, 0.95);
          type = r4 < conifer ? 0 : 1;
          break;
        }
        case Zone.Park: p = 0.2; type = r4 < 0.2 ? 0 : 1; break;
        case Zone.Hillside: p = 0.2; type = r4 < 0.3 ? 0 : 1; break;
        case Zone.Residential: p = 0.1; type = 1; break;
        case Zone.Village: p = 0.08; type = r4 < 0.6 ? 0 : 1; break;
        case Zone.Rural: p = noise2(x / 45, z / 45, 99) > 0.42 ? 0.5 : 0.012; type = r4 < 0.25 ? 0 : 1; break;
        case Zone.Alpine: p = w.terrainAt(x, z) < 240 ? 0.05 : 0; type = 0; break;
        case Zone.OldTown: case Zone.Downtown: p = 0.012; type = 2; break;
        default: p = 0;
      }
      if (r3 >= p) continue;
      if (!treeOk(x, z, zone === Zone.Forest ? 2.4 : 1.2)) continue;
      const sx = (w.terrainAt(x + 2, z) - w.terrainAt(x - 2, z)) / 4, sz = (w.terrainAt(x, z + 2) - w.terrainAt(x, z - 2)) / 4;
      if (sx * sx + sz * sz > 1.3) continue;
      const y = w.terrainAt(x, z);
      const s = 0.75 + r4 * 0.6 + (zone === Zone.Forest ? 0.15 : 0);
      trees.push({ x, z, y: y - 0.1, s, type });
      trunk = type === 0 ? 0.26 : 0.34;
      w.colliders.add(circleCollider(x, z, trunk * s, y - 1, y + 9));
    }
  }
  return { buildings, trees, lamps, parking, signals };
}
