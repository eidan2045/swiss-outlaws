// Hand-authored geography of the compressed Swiss world ("Zürich-inspired" vertical slice).
// Coordinates: metres, +X east, +Z south, +Y up. Lake level is y = 0.
import { Vec2, catmullRom, clamp, clamp01, dist2, distToSegment, lerp, smoothstep, fbm2, noise2, ridged2 } from '../math';

export const WORLD_HALF = 1536;
export const WORLD_SIZE = WORLD_HALF * 2;
export const WATER_LEVEL = 0;
export const SEED = 20261125;

export const enum Zone {
  Water = 0,
  OldTown = 1,
  Downtown = 2,
  Business = 3,
  Residential = 4,
  Hillside = 5,
  Industrial = 6,
  Village = 7,
  Rural = 8,
  Forest = 9,
  Alpine = 10,
  Park = 11,
  Station = 12,
}
export const ZONE_NAMES = ['Wasser', 'Altstadt', 'City', 'Zürich-West', 'Wohnquartier', 'Zürichberg', 'Industrie', 'Bergdorf', 'Land', 'Wald', 'Alpin', 'Park', 'Bahnhof'];

// ---------------------------------------------------------------- lake
const LAKE_POLY: Vec2[] = [
  { x: -600, z: 452 }, { x: -430, z: 418 }, { x: -300, z: 402 }, { x: -120, z: 396 }, { x: -24, z: 392 }, { x: 24, z: 392 },
  { x: 150, z: 398 }, { x: 300, z: 412 }, { x: 420, z: 440 }, { x: 560, z: 492 }, { x: 700, z: 570 }, { x: 800, z: 700 },
  { x: 880, z: 900 }, { x: 950, z: 1150 }, { x: 1040, z: 1400 }, { x: 1100, z: 1700 }, { x: -1040, z: 1700 }, { x: -990, z: 1380 },
  { x: -930, z: 1120 }, { x: -850, z: 900 }, { x: -770, z: 700 }, { x: -690, z: 540 },
];

/** Signed distance to lake shore: negative inside the lake. */
export function lakeSd(x: number, z: number): number {
  if (z < 60) return 392 - z; // far north of the lake (all users saturate beyond ~310 m)
  let inside = false;
  let best = 1e9;
  const n = LAKE_POLY.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = LAKE_POLY[i], b = LAKE_POLY[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z);
    if (d < best) best = d;
  }
  return inside ? -best : best;
}

// ---------------------------------------------------------------- river (Limmat)
const RIVER_CTRL: Vec2[] = [
  { x: 0, z: 470 }, { x: 0, z: 392 }, { x: -6, z: 250 }, { x: -16, z: 60 }, { x: -30, z: -130 }, { x: -52, z: -320 }, { x: -95, z: -480 },
  { x: -180, z: -610 }, { x: -320, z: -700 }, { x: -520, z: -760 }, { x: -780, z: -800 }, { x: -1080, z: -850 }, { x: -1350, z: -900 }, { x: -1700, z: -950 },
];
export const RIVER_PATH: Vec2[] = catmullRom(RIVER_CTRL, 20);
export const RIVER_HALF_WIDTH = 24;

const _t = [0];
/** Distance to river centreline. */
export function riverDist(x: number, z: number): number {
  // coarse reject
  if (z > 500 || z < -1000) return 1e9;
  if (x > 120 || (x < -200 && z > -520)) return 1e9;
  let best = 1e9;
  for (let i = 0; i < RIVER_PATH.length - 1; i++) {
    const a = RIVER_PATH[i], b = RIVER_PATH[i + 1];
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z, _t);
    if (d < best) best = d;
  }
  return best;
}
/** X coordinate of the river centreline at latitude z (valid for the straight city reach). */
export function riverX(z: number): number {
  const c = RIVER_CTRL;
  if (z >= c[1].z) return c[1].x;
  for (let i = 1; i < 6; i++) {
    if (z <= c[i].z && z >= c[i + 1].z) {
      return lerp(c[i].x, c[i + 1].x, (c[i].z - z) / (c[i].z - c[i + 1].z));
    }
  }
  return c[6].x;
}

/** True on the left bank looking downstream (west bank in the city reach, south bank after the bend). */
export function leftOfRiver(x: number, z: number): boolean {
  let best = 1e9, side = 0;
  for (let i = 0; i < RIVER_PATH.length - 1; i++) {
    const a = RIVER_PATH[i], b = RIVER_PATH[i + 1];
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z);
    if (d < best) {
      best = d;
      side = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
    }
  }
  return side < 0;
}

// ---------------------------------------------------------------- mountain valley
export const VALLEY: { x: number; z: number; y: number; w: number }[] = [
  { x: 900, z: -1134, y: 40, w: 50 },
  { x: 980, z: -1140, y: 52, w: 100 },
  { x: 1080, z: -1140, y: 62, w: 120 },
  { x: 1220, z: -1120, y: 74, w: 95 },
  { x: 1390, z: -1090, y: 90, w: 55 },
];
export const VILLAGE_CENTER = { x: 1030, z: -1140 };
export const PASS_SADDLE = { x: 965, z: -800 };
export const UETLIBERG_TOP = { x: -1400, z: 540 };
export const PASS_HEIGHT = 165;
export const HB_CENTER = { x: -275, z: -379 };

function valleyTarget(x: number, z: number): number {
  if (x < 700 || z > -850) return 1e9;
  let best = 1e9;
  for (let i = 0; i < VALLEY.length - 1; i++) {
    const a = VALLEY[i], b = VALLEY[i + 1];
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z, _t);
    const t = _t[0];
    const floor = lerp(a.y, b.y, t), w = lerp(a.w, b.w, t);
    const over = Math.max(0, d - w);
    // glacial U profile: flat floor, walls steepening
    const h = floor + over * 0.2 + Math.min(over, 240) * 0.38 + (over * over) / 2600;
    if (h < best) best = h;
  }
  return best;
}

// ---------------------------------------------------------------- base terrain (before roads)
function blob(x: number, z: number, cx: number, cz: number, rx: number, rz: number): number {
  const dx = (x - cx) / rx, dz = (z - cz) / rz;
  return smoothstep(1, 0.3, dx * dx + dz * dz);
}
/** Organic mountain influence 0..1 (noise-warped blobs, no straight edges). */
export function mountainMask(x: number, z: number): number {
  const wx = x + 70 * noise2(x / 310, z / 310, 501), wz = z + 70 * noise2(x / 310, z / 310, 502);
  const north = blob(wx, wz, 1200, -1340, 660, 430); // massif around the valley basin
  const east = blob(wx, wz, 1560, -850, 300, 640); // east wall
  const pre = blob(wx, wz, -150, -1700, 1000, 300) * 0.42; // low pre-alps along the north edge
  return Math.max(north, east, pre);
}
// Pass ridge: W-E crest line between the valley and the Zürichberg, with a saddle.
const RIDGE: { x: number; z: number; y: number }[] = [
  { x: 540, z: -800, y: 40 }, { x: 740, z: -806, y: 176 }, { x: 965, z: -800, y: 165 }, { x: 1150, z: -796, y: 186 }, { x: 1330, z: -806, y: 250 }, { x: 1520, z: -815, y: 340 },
];
const _r = [0];
/** out: [crest height, flank factor 0..1] */
function ridgeAt(x: number, z: number, out: number[]): void {
  out[0] = 0;
  out[1] = 0;
  if (x < 150 || z > -380 || z < -1250) return;
  const wx = x + 36 * noise2(x / 170, z / 170, 601), wz = z + 36 * noise2(x / 170, z / 170, 602);
  let best = 1e9, crest = 0;
  for (let i = 0; i < RIDGE.length - 1; i++) {
    const a = RIDGE[i], b = RIDGE[i + 1];
    const d = distToSegment(wx, wz, a.x, a.z, b.x, b.z, _r);
    if (d < best) {
      best = d;
      crest = lerp(a.y, b.y, _r[0]);
    }
  }
  const u = clamp01(best / 350);
  out[0] = crest;
  out[1] = 1 - u * u * (3 - 2 * u);
}
function riegel(x: number, z: number): number {
  return blob(x + 30 * noise2(z / 160, 3.3, 77), z, 742, -1150, 185, 340);
}
const _ro = [0, 0];
/** 0..1: how much a point belongs to mountain terrain (for zoning / vegetation). */
export function alpineness(x: number, z: number): number {
  ridgeAt(x, z, _ro);
  return Math.max(mountainMask(x, z), _ro[1] * (_ro[0] > 120 ? 1 : 0.5), riegel(x, z));
}

export function baseHeight(x: number, z: number): number {
  // --- lowland plain
  let h = 6.0 + 2.0 * fbm2(x / 520, z / 520, 3, 11) + 0.45 * noise2(x / 75, z / 75, 5);

  const rx = riverX(clamp(z, -330, 392));
  // city rises gently away from the river
  h += Math.min(5, Math.abs(x - rx) * 0.01);

  // --- Lindenhof: small old-town hill west of the river
  {
    const dx = (x + 118) / 70, dz = (z - 70) / 95;
    const d2 = dx * dx + dz * dz;
    if (d2 < 1) h += 8 * (1 - d2) * (1 - d2);
  }

  // --- Zürichberg: broad eastern hill (kept gentle enough for streets)
  {
    const u = clamp01((x - 250) / 650);
    const eu = lerp(u, u * u * (3 - 2 * u), 0.35);
    const along = smoothstep(-720, -480, z) * (1 - smoothstep(560, 900, z) * 0.55);
    let hill = 60 * eu * along * (0.9 + 0.1 * fbm2(x / 260, z / 260, 3, 23));
    // rolling forest hills further east and south-east
    hill += smoothstep(820, 1300, x) * (1 - smoothstep(-760, -520, -z) * 0) * 34 * (0.6 + 0.4 * fbm2(x / 230, z / 230, 3, 29)) * smoothstep(-760, -560, z);
    hill *= smoothstep(0, 300, lakeSd(x, z) - 8);
    h += hill;
  }

  // --- Uetliberg ridge in the west
  {
    const u = smoothstep(-1020, -1420, x);
    const along = smoothstep(-420, -80, z) * (1 - 0.3 * smoothstep(1000, 1500, z));
    h += 195 * u * along * (0.95 + 0.05 * fbm2(x / 300, z / 240, 3, 41)) * clamp01((lakeSd(x, z) + 10) / 120 + 0.25);
  }

  // --- rock bar ("Riegel") closing the mountain valley: the motorway tunnels through it
  h += 100 * riegel(x, z);

  // --- alps (noise driven)
  const mm = mountainMask(x, z);
  if (mm > 0) {
    const big = ridged2(x / 760 + 3.1, z / 760 - 1.7, 5, 77);
    const detail = fbm2(x / 120, z / 120, 4, 91);
    const far = smoothstep(900, 1500, x) * 0.6 + smoothstep(-1150, -1500, z) * 0.55;
    const mh = 110 + 300 * big + 320 * far * (0.4 + big) + 24 * detail;
    h = lerp(h, Math.max(h, mh), mm);
  }
  // --- pass ridge
  ridgeAt(x, z, _ro);
  if (_ro[1] > 0) {
    const crest = _ro[0] + 7 * fbm2(x / 90, z / 90, 3, 93);
    if (crest > h) h += (crest - h) * _ro[1];
  }

  // --- glacial valley with the mountain village
  const vt = valleyTarget(x, z);
  if (vt < h) h = lerp(h, vt, smoothstep(800, 880, x));

  // --- lake basin
  const ls = lakeSd(x, z);
  if (ls < 26) {
    // steep quay wall along the city centre, natural beach elsewhere
    const quay = smoothstep(-640, -470, x) * (1 - smoothstep(330, 470, x));
    const beach = lerp(26, 3.0, quay);
    const t = clamp01((beach - ls) / beach);
    const shoreH = lerp(h, -0.6, t * t);
    const depth = -0.6 - Math.min(34, Math.max(0, -ls) * lerp(0.085, 0.9, quay) + Math.max(0, -ls - 14) * 0.06);
    h = ls < 0 ? Math.min(shoreH, depth) : shoreH;
  }

  // --- river channel
  const rd = riverDist(x, z);
  if (rd < RIVER_HALF_WIDTH + 30) {
    const natural = clamp01(smoothstep(-600, -800, z) * 0.5 + smoothstep(-700, -1000, x));
    const bank = lerp(2.4, 20, natural);
    const t = clamp01((RIVER_HALF_WIDTH + bank - rd) / bank);
    const bed = -3.4 - 1.2 * clamp01((RIVER_HALF_WIDTH - rd) / RIVER_HALF_WIDTH);
    const target = lerp(h, bed, t * t * (3 - 2 * t));
    h = Math.min(h, rd < RIVER_HALF_WIDTH ? Math.min(target, -1.2) : target);
  }
  return h;
}

// ---------------------------------------------------------------- zoning
export function zoneAt(x: number, z: number, h: number, slope: number): Zone {
  if (h < WATER_LEVEL - 0.15) return Zone.Water;
  const rx = riverX(clamp(z, -330, 392));
  const u = x - rx;
  // village on the valley floor
  if (dist2(x, z, VILLAGE_CENTER.x, VILLAGE_CENTER.z) < 200 && h < 80 && slope < 0.3) return Zone.Village;
  if (alpineness(x, z) > 0.3) {
    const tree = 150 + 30 * noise2(x / 140, z / 140, 301);
    if (h > tree || slope > 1.05) return Zone.Alpine;
    if (h < 100 && slope < 0.2 && x > 880 && z < -1020) return Zone.Rural;
    return Zone.Forest;
  }
  // station + tracks
  if (z > -424 && z < -334 && x < -140) return Zone.Station;
  // parks
  if (dist2(x, z, -118, 70) < 60) return Zone.Park; // Lindenhof
  if (x > -330 && x < -215 && z > 318 && z < 398) return Zone.Park; // Bürkli lake park
  if (z > 300 && x > -660 && x < 430 && lakeSd(x, z) < 30) return Zone.Park; // lake promenade
  if (x > 268 && x < 410 && z > 322 && z < 440) return Zone.Park; // Sechseläuten meadow / opera
  if (x > 300 && x < 460 && z > -120 && z < 20) return Zone.Park; // university terrace
  if (x > -900 && x < -735 && z > 20 && z < 150) return Zone.Park; // Bäckeranlage
  // old town both sides of the river
  if (z > -300 && z < 400 && u > -168 && u < 246) return Zone.OldTown;
  // downtown (Bahnhofstrasse quarter)
  if (z > -334 && z < 440 && u <= -168 && x > -640) return Zone.Downtown;
  // Zürich-West: modern business north of the tracks, industry further west (south bank only)
  if (z <= -424 && z > -900 && x < -90 && x > -1340 && riverDist(x, z) > 30 && leftOfRiver(x, z)) {
    return x > -640 ? Zone.Business : Zone.Industrial;
  }
  // west residential grid
  if (x <= -640 && x >= -1040 && z > -334 && lakeSd(x, z) > 0) return Zone.Residential;
  // organic (noise-warped) boundaries for everything outside the dense city
  const wx = x + 34 * noise2(x / 150, z / 150, 401), wz = z + 34 * noise2(x / 150, z / 150, 402);
  // Uetliberg: forest on the slopes
  if (wx < -1040 && z > -334) return h > 22 || slope > 0.25 ? Zone.Forest : Zone.Rural;
  // east side: Zürichberg
  if (u >= 246 && wz > -520 && wz < 600) {
    if (wx > 838) return Zone.Forest;
    return x > 430 ? Zone.Hillside : Zone.Residential;
  }
  if (wx >= 838 && wz > -760) return Zone.Forest;
  if (x > 300 && wz >= 600) return slope > 0.35 || wx > 1010 ? Zone.Forest : Zone.Hillside;
  // north-east quarter then farmland
  if (x > -40 && x < 300 && z <= -300 && wz > -640) return Zone.Residential;
  const f = fbm2(x / 210 + 9.3, z / 210 - 4.1, 3, 61);
  if (f > 0.2 || slope > 0.4) return Zone.Forest;
  return Zone.Rural;
}

// ---------------------------------------------------------------- authored roads
export type RoadType = 'highway' | 'main' | 'street' | 'alley' | 'rural' | 'track';
export interface RoadDef {
  type: RoadType;
  name: string;
  pts: Vec2[];
  /** spline smoothing (default true for >2 points) */
  smooth?: boolean;
  bridge?: boolean; // may cross water (otherwise clipped at water)
  tunnel?: [number, number]; // [fromIndex, toIndex] control-point range that is underground
  viaduct?: [number, number]; // control-point range carried on an elevated deck (no junctions)
  tram?: boolean;
  noBuildings?: boolean;
  oneWay?: boolean;
  /** impose a linear height ramp along the road; null = terrain height at that end */
  ramp?: [number | null, number | null];
}

function P(x: number, z: number): Vec2 {
  return { x, z };
}
/** Grid X for a river-relative offset u: streets near the river follow it, far streets are straight. */
export function gx(u: number, z: number): number {
  return u + riverX(clamp(z, -330, 392)) * (1 - smoothstep(200, 520, Math.abs(u)));
}
/** N-S street at river-relative offset u, with deterministic wobble. */
function nsLine(u: number, z0: number, z1: number, wob: number, seed: number): Vec2[] {
  const pts: Vec2[] = [];
  const n = Math.max(2, Math.round(Math.abs(z1 - z0) / 110));
  for (let i = 0; i <= n; i++) {
    const z = lerp(z0, z1, i / n);
    const w = i === 0 || i === n ? 0 : wob * noise2(z / 170, seed * 7.13, seed);
    pts.push(P(gx(u, z) + w, z));
  }
  return pts;
}
/** E-W street at latitude z between river-relative offsets u0..u1. */
function ewLine(z: number, u0: number, u1: number, wob: number, seed: number): Vec2[] {
  const pts: Vec2[] = [];
  const n = Math.max(2, Math.round(Math.abs(u1 - u0) / 120));
  for (let i = 0; i <= n; i++) {
    const u = lerp(u0, u1, i / n);
    const w = i === 0 || i === n ? 0 : wob * noise2(u / 190, seed * 3.7, seed + 50);
    const zz = z + w;
    pts.push(P(gx(u, zz), zz));
  }
  return pts;
}

/** Switchbacks: legs run along `al`, stack along `up`. Returns control points. */
function switchbacks(ax: number, az: number, alx: number, alz: number, upx: number, upz: number, legLen: number, spacing: number, legs: number, firstDir: number, r = 14): Vec2[] {
  const pts: Vec2[] = [];
  let dir = firstDir;
  for (let i = 0; i < legs; i++) {
    const ox = ax + upx * spacing * i, oz = az + upz * spacing * i;
    const s0 = dir > 0 ? 0 : legLen, s1 = dir > 0 ? legLen : 0;
    const k = 4;
    for (let j = 0; j <= k; j++) {
      const s = lerp(s0, s1, j / k);
      pts.push(P(ox + alx * s, oz + alz * s));
    }
    if (i < legs - 1) {
      const ex = ox + alx * (s1 + dir * r), ez = oz + alz * (s1 + dir * r);
      pts.push(P(ex + upx * spacing * 0.5, ez + upz * spacing * 0.5));
    }
    dir = -dir;
  }
  return pts;
}

export function buildRoadDefs(): RoadDef[] {
  const R: RoadDef[] = [];
  const add = (type: RoadType, name: string, pts: Vec2[], o: Partial<RoadDef> = {}) => R.push({ type, name, pts, ...o });
  const G = (u: number, z: number) => P(gx(u, z), z);

  // ============ lake quay + Quaibrücke, shore roads
  add('main', 'General-Guisan-Quai', [P(-640, 432), P(-520, 400), P(-360, 380), P(-172, 372), P(-40, 370), P(40, 370), P(170, 376), P(258, 392)], { bridge: true, tram: true });
  add('main', 'Seestrasse Ost', [P(258, 392), P(330, 384), P(450, 412), P(590, 464), P(720, 538), P(830, 662), P(905, 800), P(960, 960), P(1010, 1150), P(1075, 1380), P(1110, 1530)]);
  add('main', 'Seestrasse West', [P(-640, 432), P(-712, 520), P(-790, 660), P(-865, 820), P(-940, 1010), P(-1000, 1220), P(-1040, 1400), P(-1060, 1530)]);

  // ============ west bank north-south
  add('street', 'Schipfe', nsLine(-40, 372, -300, 3, 1));
  add('alley', 'Augustinergasse', nsLine(-104, 372, 156, 7, 2));
  add('alley', 'Rennweg', nsLine(-100, -24, -310, 6, 22));
  add('main', 'Bahnhofstrasse', nsLine(-172, 372, -314, 2, 3), { tram: true });
  add('street', 'Löwenstrasse', nsLine(-258, 378, -318, 5, 4));
  add('main', 'Talstrasse', nsLine(-345, 382, -318, 5, 5));
  add('street', 'Pelikanstrasse', nsLine(-435, 390, -318, 7, 6));
  add('street', 'Selnaustrasse', nsLine(-525, 400, -318, 7, 7));
  add('street', 'Kasernenstrasse', [P(-712, 520), ...nsLine(-722, 430, -318, 8, 9)]);
  add('street', 'Ankerstrasse', [P(-790, 660), P(-812, 560), ...nsLine(-818, 470, -318, 8, 10)]);
  add('main', 'Hardstrasse', [P(-865, 820), P(-900, 700), ...nsLine(-915, 600, -204, 6, 11)]);
  add('main', 'Hardbrücke', [P(-915, -204), P(-915, -262), P(-914, -330), P(-910, -440), P(-898, -510), P(-880, -566)], { viaduct: [1, 4], noBuildings: true });
  add('street', 'Zypressenstrasse', [P(-940, 1010), P(-985, 880), ...nsLine(-1012, 760, -300, 9, 12)]);
  add('main', 'Langstrasse', nsLine(-618, 428, -318, 4, 8));
  add('main', 'Kornhausstrasse', [P(-628, -440), P(-636, -560), P(-640, -733), P(-632, -800), P(-600, -900), P(-560, -1000), P(-520, -1052)], { bridge: true });

  // ============ west bank east-west
  const westEW: [number, string, RoadType, number][] = [
    [300, 'Börsenstrasse', 'street', -1012], [228, 'Bleicherweg', 'main', -1012], [156, 'Bärengasse', 'street', -915], [84, 'Paradeplatz', 'main', -1012],
    [12, 'Pelikanplatz', 'street', -915], [-60, 'Uraniastrasse', 'street', -1012], [-132, 'Sihlporte', 'main', -1012], [-204, 'Schützengasse', 'street', -915],
  ];
  westEW.forEach(([z, name, type, uEnd], i) => add(type, name, ewLine(z, -40, uEnd, 6, 30 + i), { tram: z === 84 }));
  add('main', 'Lagerstrasse', [P(-96, -306), G(-172, -314), G(-345, -318), P(-618, -318), P(-915, -318), P(-1012, -300)]);
  add('street', 'Seebahnstrasse', ewLine(380, -618, -1012, 5, 44));
  add('street', 'Birmensdorferstrasse', [P(-678, 478), P(-800, 484), P(-1012, 480)]);
  add('street', 'Goldbrunnenstrasse', [P(-757, 600), P(-900, 604), P(-1012, 600)]);
  add('street', 'Wiesenweg', [P(-826, 738), P(-920, 742), P(-1012, 740)]);
  // old-town alleys west
  [264, 192, 120, 48, -24, -96, -168, -240].forEach((z, i) => add('alley', 'Gasse W' + i, ewLine(z, -40, -172, 5, 60 + i)));

  // ============ bridges over the Limmat
  add('street', 'Münsterbrücke', ewLine(228, -40, 40, 0, 80), { bridge: true });
  add('street', 'Rathausbrücke', ewLine(84, -40, 40, 0, 81), { bridge: true });
  add('street', 'Rudolf-Brun-Brücke', ewLine(-132, -40, 40, 0, 82), { bridge: true });
  add('main', 'Bahnhofbrücke', [P(-96, -306), P(-50, -302), P(-8, -300)], { bridge: true, tram: true });

  // ============ east bank
  add('main', 'Limmatquai', [...nsLine(40, 370, -300, 2, 13), P(-8, -300), P(-22, -420), P(-34, -520), P(-20, -640), P(40, -790), P(86, -920), P(100, -1040)], { tram: true });
  add('alley', 'Niederdorfstrasse', nsLine(106, 374, -300, 8, 14));
  add('alley', 'Zähringerstrasse', nsLine(176, 378, -300, 8, 15));
  add('main', 'Rämistrasse', [P(258, 392), ...nsLine(254, 300, -300, 6, 16), P(180, -420), P(150, -520)]);
  [300, 228, 156, 84, 12, -60, -132, -204].forEach((z, i) => add(z === 228 || z === -132 ? 'street' : 'alley', 'Gasse O' + i, ewLine(z, 40, 254, 6, 90 + i)));
  add('street', 'Central', [P(-8, -300), P(100, -298), P(190, -300), P(226, -300)]);
  add('street', 'Stampfenbachstrasse', [P(-34, -520), P(60, -512), P(150, -520), P(250, -500)]);
  add('street', 'Weinbergstrasse', [P(150, -520), P(160, -630), P(40, -790)]);

  // ============ Zürichberg hillside: contour roads + diagonal climbers
  add('street', 'Hottingerstrasse', [P(392, 398), P(372, 330), P(356, 200), P(366, 60), P(350, -90), P(362, -240), P(340, -380), P(250, -500)]);
  add('street', 'Freiestrasse', [P(520, 438), P(500, 360), P(478, 210), P(492, 60), P(474, -100), P(488, -260), P(470, -420)]);
  add('street', 'Bergstrasse', [P(655, 500), P(636, 370), P(612, 220), P(630, 60), P(610, -110), P(626, -280), P(600, -440)]);
  add('street', 'Krähbühlstrasse', [P(780, 320), P(756, 170), P(774, 20), P(752, -140), P(768, -300), P(740, -430)]);
  add('main', 'Zürichbergstrasse', [G(254, 84), P(366, 60), P(492, 60), P(630, 60), P(774, 20), P(860, -60), P(900, -220), P(880, -400)]);
  add('street', 'Klosbachstrasse', [G(254, 300), P(372, 330), P(500, 360), P(636, 370), P(780, 320)]);
  add('street', 'Gloriastrasse', [G(254, -132), P(350, -90), P(474, -100), P(610, -110), P(752, -140), P(860, -60)]);
  add('street', 'Schmelzbergstrasse', [P(226, -300), P(340, -380), P(470, -420), P(600, -440), P(740, -430), P(880, -400)]);

  // ============ Zürich-West / industry north of the tracks
  add('street', 'Zollstrasse', [P(-130, -446), P(-200, -446), P(-420, -448), P(-628, -440), P(-880, -440), P(-1100, -446), P(-1290, -450)]);
  add('street', 'Heinrichstrasse', [P(-170, -530), P(-250, -540), P(-430, -548), P(-636, -560), P(-880, -566), P(-1100, -572), P(-1290, -580)]);
  add('street', 'Limmatstrasse', [P(-250, -600), P(-420, -685), P(-640, -733), P(-880, -772), P(-1100, -808), P(-1290, -844)]);
  add('street', 'Museumstrasse', [P(-130, -446), P(-170, -530)]);
  add('street', 'Sihlquai', [P(-200, -446), P(-250, -540), P(-250, -600)]);
  add('street', 'Hafnerstrasse', [P(-420, -448), P(-430, -548), P(-420, -685)]);
  add('street', 'Viaduktstrasse', [P(-880, -440), P(-880, -566), P(-880, -772)]);
  add('street', 'Pfingstweidstrasse', [P(-1100, -446), P(-1100, -572), P(-1100, -808)]);
  add('street', 'Förrlibuckstrasse', [P(-1290, -450), P(-1290, -580), P(-1290, -844)]);
  add('street', 'Bahnhofquai', [P(-96, -306), P(-114, -380), P(-130, -446)]);

  // ============ motorway A1 across the north, tunnel into the mountain valley
  add('highway', 'A1', [P(-1530, -1096), P(-1200, -1076), P(-900, -1062), P(-520, -1052), P(-200, -1044), P(100, -1040), P(380, -1058), P(540, -1088), P(618, -1104), P(730, -1124), P(840, -1131), P(900, -1134)], { tunnel: [8, 10], noBuildings: true });
  add('main', 'Dorfstrasse', [P(900, -1134), P(960, -1142), P(1030, -1150), P(1110, -1146), P(1220, -1124), P(1330, -1100), P(1396, -1087)]);
  add('rural', 'Alte Landstrasse', [P(250, -500), P(330, -600), P(420, -720), P(470, -860), P(430, -980), P(380, -1058)]);

  // ============ pass road: village → saddle → Zürichberg (loop back to the city)
  const north = switchbacks(950, -1012, 1, 0, 0, 1, 290, 50, 4, 1);
  const south = switchbacks(720, -722, 1, 0, 0, 1, 270, 78, 3, -1, 16);
  add('rural', 'Passstrasse', [P(1030, -1150), P(1004, -1092), P(962, -1046), ...north, P(944, -836), P(PASS_SADDLE.x, PASS_SADDLE.z)], { noBuildings: true, ramp: [null, PASS_HEIGHT] });
  add('rural', 'Passstrasse Süd', [P(PASS_SADDLE.x, PASS_SADDLE.z), P(1002, -768), ...south, P(742, -500), P(810, -440), P(880, -400)], { noBuildings: true, ramp: [PASS_HEIGHT, null] });

  // ============ farmland roads in the north
  add('rural', 'Feldweg Nord', [P(-520, -1052), P(-500, -1180), P(-380, -1280), P(-150, -1310), P(100, -1270), P(100, -1040)]);
  add('rural', 'Hofstrasse', [P(-1200, -1076), P(-1180, -1210), P(-1000, -1290), P(-760, -1260), P(-500, -1180)]);
  add('rural', 'Mühleweg', [P(100, -1270), P(280, -1260), P(400, -1180), P(380, -1058)]);

  // ============ Uetliberg road: long traverse, hairpin, crest road to the lookout tower
  add('rural', 'Uetlibergstrasse', [P(-1012, -300), P(-1060, -180), P(-1100, -40), P(-1125, 150), P(-1150, 380), P(-1178, 620), P(-1208, 860), P(-1240, 1080), P(-1262, 1190), P(-1296, 1236), P(-1320, 1160), P(-1322, 1020), P(-1338, 860), P(-1362, 700), P(UETLIBERG_TOP.x + 8, UETLIBERG_TOP.z + 26)], { noBuildings: true, ramp: [null, null] });

  // railway (visual only)
  add('track', 'Gleisfeld', [P(-160, -379), P(-600, -379), P(-1100, -379), P(-1536, -379)], { noBuildings: true, smooth: false });

  return R;
}

export interface Poi {
  id: string;
  name: string;
  x: number;
  z: number;
  kind: 'landmark' | 'spawn' | 'shop' | 'garage' | 'hospital' | 'police' | 'mission' | 'viewpoint';
}
export const POIS: Poi[] = [
  { id: 'hb', name: 'Hauptbahnhof', x: -224, z: -330, kind: 'landmark' },
  { id: 'spawn', name: 'Bürkliplatz', x: -150, z: 352, kind: 'spawn' },
  { id: 'parade', name: 'Paradeplatz', x: -186, z: 84, kind: 'landmark' },
  { id: 'gross', name: 'Grossmünster', x: 92, z: 150, kind: 'landmark' },
  { id: 'frau', name: 'Fraumünster', x: -78, z: 196, kind: 'landmark' },
  { id: 'peter', name: 'St. Peter', x: -92, z: 122, kind: 'landmark' },
  { id: 'linden', name: 'Lindenhof', x: -118, z: 70, kind: 'viewpoint' },
  { id: 'opera', name: 'Opernhaus', x: 318, z: 368, kind: 'landmark' },
  { id: 'uni', name: 'Hochschule', x: 372, z: -52, kind: 'landmark' },
  { id: 'tower', name: 'Prime-Turm', x: -560, z: -500, kind: 'landmark' },
  { id: 'dealer', name: 'Garage Hürlimann', x: -770, z: -500, kind: 'shop' },
  { id: 'garage', name: 'Werkstatt Zürich-West', x: -980, z: -505, kind: 'garage' },
  { id: 'hospital', name: 'Universitätsspital', x: 300, z: -190, kind: 'hospital' },
  { id: 'police', name: 'Polizeiwache Urania', x: -150, z: -84, kind: 'police' },
  { id: 'village', name: 'Alpwil', x: VILLAGE_CENTER.x, z: VILLAGE_CENTER.z, kind: 'landmark' },
  { id: 'pass', name: 'Passhöhe', x: PASS_SADDLE.x, z: PASS_SADDLE.z, kind: 'viewpoint' },
  { id: 'uetli', name: 'Uetliberg Kulm', x: UETLIBERG_TOP.x, z: UETLIBERG_TOP.z, kind: 'viewpoint' },
];
