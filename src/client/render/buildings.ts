// Building meshes: per-chunk merged geometry generated from the shared building specs.
import * as THREE from 'three';
import { Rng, clamp } from '../../shared/math';
import { World } from '../../shared/world/world';
import { WORLD_HALF } from '../../shared/world/layout';
import { BKind, Building } from '../../shared/world/city';
import { MeshBuilder } from './meshbuilder';
import { FacadeAtlas, T, buildFacadeAtlas } from './facades';
import { Quality, U, patchMaterial, replaceOnce } from './globals';
import { makeFlatRoof, makeRoofTiles } from './textures';
import { CHUNK, CHUNKS } from './terrain';

type RGB = [number, number, number];
const hex = (h: number): RGB => {
  const c = new THREE.Color(h);
  return [c.r, c.g, c.b]; // linear
};
const PAL = {
  oldtown: [0xe8dcc0, 0xe6c9a0, 0xd9b38c, 0xc9d4c0, 0xe0c0b0, 0xf0ead8, 0xcfd8e0, 0xe8d080, 0xd8a890, 0xeee6d0].map(hex),
  downtown: [0xcfc8b8, 0xbfb8a8, 0xd8d0c0, 0xa8a498, 0xc8b8a0, 0xd6cdb9].map(hex),
  office: [0xb8bcc0, 0xd0d0d0, 0x909498, 0xe0e0e0, 0xa7b0b8].map(hex),
  apartment: [0xf0ead8, 0xe0d8c8, 0xd8c8a8, 0xc8d0c8, 0xe8e0d0, 0xd0b898, 0xb8c0c8, 0xe9d7b4].map(hex),
  villa: [0xf4f0e6, 0xece4d4, 0xe8dcc8, 0xf0e6c8].map(hex),
  hall: [0xa8b0b8, 0xc0c4c8, 0x8898a8, 0xb0a890, 0x9aa39a, 0xc9b79a].map(hex),
  timber: [0x6a4628, 0x5a3a20, 0x7a5632, 0x4e3420, 0x8a6238].map(hex),
  accent: [0x2f5d3a, 0x7a1f1f, 0x2d4a6b, 0x5a3a22, 0xc8a030, 0xa03020, 0x3c6e68, 0x8a8f96].map(hex),
  clay: [0x8a4a32, 0x7a4030, 0x96553a, 0x6a3a2c, 0x84503c].map(hex),
  slate: [0x3c4046, 0x4a4e54, 0x54585c].map(hex),
  flat: [0x5a5c5e, 0x6e6e6c, 0x4e5052, 0x7a7872].map(hex),
  stoneRoof: [0x5c5a56, 0x6a655c, 0x4c4a48].map(hex),
  copper: hex(0x5f9482),
  sandstone: hex(0xcdbf9f),
};

class Xf {
  sin: number;
  cos: number;
  constructor(public b: Building) {
    this.sin = Math.sin(b.rot);
    this.cos = Math.cos(b.rot);
  }
  X(lx: number, lz: number): number { return this.b.x + this.cos * lx + this.sin * lz; }
  Z(lx: number, lz: number): number { return this.b.z - this.sin * lx + this.cos * lz; }
}

interface Ctx {
  F: MeshBuilder; // facade
  RT: MeshBuilder; // tiled roofs
  RF: MeshBuilder; // flat roofs / misc
  atlas: FacadeAtlas;
}
const _r = [0, 0, 0, 0];

/** One facade run from local point A to B (A is the left end seen from outside). */
function facade(c: Ctx, xf: Xf, ax: number, az: number, bx: number, bz: number, y0: number, floors: number, floorH: number, bayW: number, rng: Rng, tint: RGB, acc: RGB, pick: (floor: number, bay: number, bays: number) => number, darken = 1): void {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.3) return;
  const nb = Math.max(1, Math.round(len / bayW));
  const F = c.F;
  F.accent(acc[0], acc[1], acc[2], 1);
  for (let i = 0; i < nb; i++) {
    const t0 = i / nb, t1 = (i + 1) / nb;
    const lx0 = ax + (bx - ax) * t0, lz0 = az + (bz - az) * t0, lx1 = ax + (bx - ax) * t1, lz1 = az + (bz - az) * t1;
    const x0 = xf.X(lx0, lz0), z0 = xf.Z(lx0, lz0), x1 = xf.X(lx1, lz1), z1 = xf.Z(lx1, lz1);
    for (let f = 0; f < floors; f++) {
      const tile = pick(f, i, nb);
      c.atlas.rect(tile, _r);
      const ya = y0 + f * floorH, yb = ya + floorH;
      F.color(tint[0] * darken, tint[1] * darken, tint[2] * darken, rng.next());
      F.quad(x0, ya, z0, x1, ya, z1, x1, yb, z1, x0, yb, z0, _r[0], _r[3], _r[2], _r[1]);
    }
  }
}
/** Plain wall strip (foundation, parapet, tower shafts) with a single tile stretched per bay. */
function band(c: Ctx, xf: Xf, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, tile: number, tint: RGB, vFrac = 1, bayW = 4): void {
  if (y1 - y0 < 0.02) return;
  const len = Math.hypot(bx - ax, bz - az);
  const nb = Math.max(1, Math.round(len / bayW));
  c.atlas.rect(tile, _r);
  const vTop = _r[3] - (_r[3] - _r[1]) * clamp(vFrac, 0.05, 1);
  c.F.color(tint[0], tint[1], tint[2], 1);
  c.F.accent(1, 1, 1, 1);
  for (let i = 0; i < nb; i++) {
    const t0 = i / nb, t1 = (i + 1) / nb;
    const lx0 = ax + (bx - ax) * t0, lz0 = az + (bz - az) * t0, lx1 = ax + (bx - ax) * t1, lz1 = az + (bz - az) * t1;
    c.F.quad(xf.X(lx0, lz0), y0, xf.Z(lx0, lz0), xf.X(lx1, lz1), y0, xf.Z(lx1, lz1), xf.X(lx1, lz1), y1, xf.Z(lx1, lz1), xf.X(lx0, lz0), y1, xf.Z(lx0, lz0), _r[0], _r[3], _r[2], vTop);
  }
}
function rectPts(hw: number, hd: number, cx = 0, cz = 0): [number, number][] {
  return [[cx - hw, cz + hd], [cx + hw, cz + hd], [cx + hw, cz - hd], [cx - hw, cz - hd]];
}
function roofQuad(B: MeshBuilder, xf: Xf, p: number[][], col: RGB, uvScale = 0.5): void {
  // p: 4 local points [lx, y, lz] counter-clockwise seen from outside
  B.color(col[0], col[1], col[2], 1);
  const w = Math.hypot(p[1][0] - p[0][0], p[1][2] - p[0][2], p[1][1] - p[0][1]);
  const h = Math.hypot(p[3][0] - p[0][0], p[3][2] - p[0][2], p[3][1] - p[0][1]);
  const P = p.map((q) => [xf.X(q[0], q[2]), q[1], xf.Z(q[0], q[2])]);
  B.quad(P[0][0], P[0][1], P[0][2], P[1][0], P[1][1], P[1][2], P[2][0], P[2][1], P[2][2], P[3][0], P[3][1], P[3][2], 0, 0, w * uvScale, h * uvScale);
}
function roofTri(B: MeshBuilder, xf: Xf, p: number[][], col: RGB, uvScale = 0.5): void {
  B.color(col[0], col[1], col[2], 1);
  const w = Math.hypot(p[1][0] - p[0][0], p[1][2] - p[0][2], p[1][1] - p[0][1]);
  const h = Math.hypot(p[2][0] - (p[0][0] + p[1][0]) / 2, p[2][2] - (p[0][2] + p[1][2]) / 2, p[2][1] - p[0][1]);
  const P = p.map((q) => [xf.X(q[0], q[2]), q[1], xf.Z(q[0], q[2])]);
  B.tri(P[0][0], P[0][1], P[0][2], P[1][0], P[1][1], P[1][2], P[2][0], P[2][1], P[2][2], 0, 0, w * uvScale, 0, w * uvScale * 0.5, h * uvScale);
}
/** Triangle of facade material (gable ends). */
function gableTri(c: Ctx, xf: Xf, a: number[], b: number[], apex: number[], tile: number, tint: RGB): void {
  c.atlas.rect(tile, _r);
  c.F.color(tint[0], tint[1], tint[2], 1);
  c.F.accent(1, 1, 1, 1);
  c.F.tri(xf.X(a[0], a[2]), a[1], xf.Z(a[0], a[2]), xf.X(b[0], b[2]), b[1], xf.Z(b[0], b[2]), xf.X(apex[0], apex[2]), apex[1], xf.Z(apex[0], apex[2]), _r[0], _r[3], _r[2], _r[3], (_r[0] + _r[2]) / 2, _r[1]);
}
function gableRoof(c: Ctx, xf: Xf, hw: number, hd: number, y: number, pitch: number, ov: number, alongX: boolean, col: RGB, gableTile: number, tint: RGB, cx = 0, cz = 0): number {
  const B = c.RT;
  if (alongX) {
    const rise = hd * pitch, yE = y - ov * pitch, yR = y + rise;
    const W = hw + ov * 0.6, D = hd + ov;
    roofQuad(B, xf, [[cx - W, yE, cz + D], [cx + W, yE, cz + D], [cx + W, yR, cz], [cx - W, yR, cz]], col);
    roofQuad(B, xf, [[cx + W, yE, cz - D], [cx - W, yE, cz - D], [cx - W, yR, cz], [cx + W, yR, cz]], col);
    gableTri(c, xf, [cx + hw, y, cz + hd], [cx + hw, y, cz - hd], [cx + hw, yR, cz], gableTile, tint);
    gableTri(c, xf, [cx - hw, y, cz - hd], [cx - hw, y, cz + hd], [cx - hw, yR, cz], gableTile, tint);
    return yR;
  }
  const rise = hw * pitch, yE = y - ov * pitch, yR = y + rise;
  const W = hw + ov, D = hd + ov * 0.6;
  roofQuad(B, xf, [[cx + W, yE, cz + D], [cx + W, yE, cz - D], [cx, yR, cz - D], [cx, yR, cz + D]], col);
  roofQuad(B, xf, [[cx - W, yE, cz - D], [cx - W, yE, cz + D], [cx, yR, cz + D], [cx, yR, cz - D]], col);
  gableTri(c, xf, [cx - hw, y, cz + hd], [cx + hw, y, cz + hd], [cx, yR, cz + hd], gableTile, tint);
  gableTri(c, xf, [cx + hw, y, cz - hd], [cx - hw, y, cz - hd], [cx, yR, cz - hd], gableTile, tint);
  return yR;
}
function hipRoof(c: Ctx, xf: Xf, hw: number, hd: number, y: number, pitch: number, ov: number, col: RGB, B = c.RT, cx = 0, cz = 0): number {
  const W = hw + ov, D = hd + ov, yE = y - ov * pitch;
  if (W >= D) {
    const rise = D * pitch, r = W - D, yR = yE + rise;
    roofQuad(B, xf, [[cx - W, yE, cz + D], [cx + W, yE, cz + D], [cx + r, yR, cz], [cx - r, yR, cz]], col);
    roofQuad(B, xf, [[cx + W, yE, cz - D], [cx - W, yE, cz - D], [cx - r, yR, cz], [cx + r, yR, cz]], col);
    roofTri(B, xf, [[cx + W, yE, cz + D], [cx + W, yE, cz - D], [cx + r, yR, cz]], col);
    roofTri(B, xf, [[cx - W, yE, cz - D], [cx - W, yE, cz + D], [cx - r, yR, cz]], col);
    return yR;
  }
  const rise = W * pitch, r = D - W, yR = yE + rise;
  roofQuad(B, xf, [[cx + W, yE, cz + D], [cx + W, yE, cz - D], [cx, yR, cz - r], [cx, yR, cz + r]], col);
  roofQuad(B, xf, [[cx - W, yE, cz - D], [cx - W, yE, cz + D], [cx, yR, cz + r], [cx, yR, cz - r]], col);
  roofTri(B, xf, [[cx - W, yE, cz + D], [cx + W, yE, cz + D], [cx, yR, cz + r]], col);
  roofTri(B, xf, [[cx + W, yE, cz - D], [cx - W, yE, cz - D], [cx, yR, cz - r]], col);
  return yR;
}
function flatRoof(c: Ctx, xf: Xf, pts: [number, number][], y: number, col: RGB): void {
  // convex polygon fan (points ordered FL, FR, BR, BL → counter-clockwise from above is reversed order)
  c.RF.color(col[0], col[1], col[2], 1);
  const p0 = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    c.RF.tri(xf.X(p0[0], p0[1]), y, xf.Z(p0[0], p0[1]), xf.X(a[0], a[1]), y, xf.Z(a[0], a[1]), xf.X(b[0], b[1]), y, xf.Z(b[0], b[1]), p0[0] * 0.25, p0[1] * 0.25, a[0] * 0.25, a[1] * 0.25, b[0] * 0.25, b[1] * 0.25);
  }
}
function boxL(B: MeshBuilder, xf: Xf, lx: number, y0: number, lz: number, hx: number, h: number, hz: number, col: RGB, uvScale = 0.25): void {
  B.color(col[0], col[1], col[2], 1);
  B.box(xf.X(lx, lz), y0 + h / 2, xf.Z(lx, lz), hx, h / 2, hz, xf.sin, xf.cos, uvScale);
}
/** Frustum / cone / spire with n sides. */
function cone(B: MeshBuilder, xf: Xf, lx: number, lz: number, r0: number, r1: number, y0: number, y1: number, sides: number, col: RGB, rot = Math.PI / 4): void {
  B.color(col[0], col[1], col[2], 1);
  for (let i = 0; i < sides; i++) {
    // decreasing angle → counter-clockwise seen from outside with y up
    const a0 = rot - (i / sides) * Math.PI * 2, a1 = rot - ((i + 1) / sides) * Math.PI * 2;
    const p = (r: number, a: number, y: number) => [xf.X(lx + Math.cos(a) * r, lz + Math.sin(a) * r), y, xf.Z(lx + Math.cos(a) * r, lz + Math.sin(a) * r)];
    const A = p(r0, a0, y0), Bp = p(r0, a1, y0);
    const w = 2 * r0 * Math.sin(Math.PI / sides), h = Math.hypot(y1 - y0, r0 - r1);
    if (r1 < 0.01) {
      const C = p(0, 0, y1);
      B.tri(A[0], A[1], A[2], Bp[0], Bp[1], Bp[2], C[0], C[1], C[2], 0, 0, w * 0.5, 0, w * 0.25, h * 0.5);
    } else {
      const C = p(r1, a1, y1), D = p(r1, a0, y1);
      B.quad(A[0], A[1], A[2], Bp[0], Bp[1], Bp[2], C[0], C[1], C[2], D[0], D[1], D[2], 0, 0, w * 0.5, h * 0.5);
    }
  }
}
function wallsPoly(c: Ctx, xf: Xf, pts: [number, number][], y0: number, floors: number, floorH: number, bayW: number, rng: Rng, tint: RGB, acc: RGB, pick: (side: number, floor: number, bay: number, bays: number) => number): void {
  for (let s = 0; s < pts.length; s++) {
    const a = pts[s], b = pts[(s + 1) % pts.length];
    facade(c, xf, a[0], a[1], b[0], b[1], y0, floors, floorH, bayW, rng, tint, acc, (f, i, n) => pick(s, f, i, n));
  }
}
function foundation(c: Ctx, xf: Xf, pts: [number, number][], y0: number, y1: number, tile: number, tint: RGB): void {
  const t: RGB = [tint[0] * 0.72, tint[1] * 0.72, tint[2] * 0.72];
  for (let s = 0; s < pts.length; s++) {
    const a = pts[s], b = pts[(s + 1) % pts.length];
    band(c, xf, a[0], a[1], b[0], b[1], y0, y1, tile, t, clamp((y1 - y0) / 3, 0.05, 1));
  }
}
function chimney(c: Ctx, xf: Xf, lx: number, lz: number, y: number, h: number): void {
  boxL(c.RF, xf, lx, y, lz, 0.38, h, 0.38, [0.5, 0.42, 0.36]);
  boxL(c.RF, xf, lx, y + h, lz, 0.46, 0.12, 0.46, [0.3, 0.29, 0.28]);
}
function dormer(c: Ctx, xf: Xf, lx: number, lz: number, y: number, tint: RGB, roofCol: RGB, tile: number): void {
  const hw = 0.9, depth = 2.0, h = 1.5;
  // front
  band(c, xf, lx - hw, lz, lx + hw, lz, y, y + h, tile, tint, 1, 10);
  band(c, xf, lx + hw, lz, lx + hw, lz - depth, y, y + h, T.OT_BLANK, tint, 0.4, 10);
  band(c, xf, lx - hw, lz - depth, lx - hw, lz, y, y + h, T.OT_BLANK, tint, 0.4, 10);
  roofQuad(c.RT, xf, [[lx + hw + 0.15, y + h - 0.08, lz + 0.2], [lx + hw + 0.15, y + h - 0.08, lz - depth], [lx, y + h + 0.6, lz - depth], [lx, y + h + 0.6, lz + 0.2]], roofCol);
  roofQuad(c.RT, xf, [[lx - hw - 0.15, y + h - 0.08, lz - depth], [lx - hw - 0.15, y + h - 0.08, lz + 0.2], [lx, y + h + 0.6, lz + 0.2], [lx, y + h + 0.6, lz - depth]], roofCol);
  gableTri(c, xf, [lx - hw, y + h, lz], [lx + hw, y + h, lz], [lx, y + h + 0.6, lz], T.OT_BLANK, tint);
}

// ====================================================================== generic buildings
function genBuilding(c: Ctx, b: Building): void {
  const xf = new Xf(b);
  const rng = new Rng(b.seed ^ 0x51ed);
  const hw = b.w / 2, hd = b.d / 2;
  const pts = rectPts(hw, hd);
  const yF = b.yF;
  const fh = b.h / b.floors;
  const acc = rng.pick(PAL.accent);
  switch (b.kind) {
    case BKind.OldTown: {
      const tint = rng.pick(PAL.oldtown);
      const roofCol = rng.pick(PAL.clay);
      const floorH = (b.h - 1.0) / b.floors;
      const door = rng.int(0, 9), arcade = rng.chance(0.12);
      const colTile = Array.from({ length: 12 }, () => rng.pick([T.OT_SHUT, T.OT_SHUT, T.OT_SHUT, T.OT_FLOWER, T.OT_FLOWER, T.OT_PLAIN]));
      const shopP = rng.chance(0.7) ? 0.8 : 0.15;
      const ground = Array.from({ length: 12 }, () => (rng.chance(shopP) ? T.OT_SHOP : T.OT_PLAIN));
      foundation(c, xf, pts, b.y0, yF, T.OT_BLANK, tint);
      wallsPoly(c, xf, pts, yF, b.floors, floorH, 3.0, rng, tint, acc, (s, f, i, n) => {
        if (s === 0) {
          if (f === 0) return arcade ? T.OT_ARCADE : i === door % n ? T.OT_DOOR : ground[i % 12];
          return f === b.floors - 1 ? (colTile[i % 12] === T.OT_PLAIN ? T.OT_PLAIN : T.OT_ATTIC) : colTile[i % 12];
        }
        if (s === 2) return f === 0 ? T.OT_PLAIN : colTile[(i + 3) % 12] === T.OT_FLOWER ? T.OT_SHUT : colTile[(i + 3) % 12];
        return (i + f) % 3 === 0 && f > 0 ? T.OT_PLAIN : T.OT_BLANK;
      });
      const top = yF + b.floors * floorH;
      band(c, xf, -hw, hd, hw, hd, top, top + 1.0, T.OT_ATTIC, tint, 0.09, 3);
      for (let s = 1; s < 4; s++) band(c, xf, pts[s][0], pts[s][1], pts[(s + 1) % 4][0], pts[(s + 1) % 4][1], top, top + 1.0, T.OT_BLANK, tint, 0.3);
      const pitch = rng.range(0.85, 1.15);
      const yR = gableRoof(c, xf, hw, hd, top + 1.0, pitch, 0.4, true, roofCol, T.OT_BLANK, tint);
      const nd = b.w > 9 ? 2 : 1;
      for (let i = 0; i < nd; i++) if (rng.chance(0.8)) dormer(c, xf, (i + 0.5) * (b.w / nd) - hw, hd * 0.55, top + 1.0 + hd * 0.45 * pitch - 0.2, tint, roofCol, T.OT_ATTIC);
      if (rng.chance(0.8)) chimney(c, xf, rng.range(-hw * 0.6, hw * 0.6), -hd * 0.3, yR - hd * 0.3 * pitch - 0.3, 1.5);
      break;
    }
    case BKind.Downtown: {
      const tint = rng.pick(PAL.downtown);
      const floorH = (b.h - 1.0) / b.floors;
      const colTile = Array.from({ length: 10 }, () => rng.pick([T.DT_WIN, T.DT_WIN, T.DT_WIN, T.DT_BALC, T.DT_PAIR]));
      const awn = rng.chance(0.5);
      foundation(c, xf, pts, b.y0, yF, T.DT_BLANK, tint);
      wallsPoly(c, xf, pts, yF, b.floors, floorH, 3.4, rng, tint, acc, (s, f, i, n) => {
        if (s === 0) {
          if (f === 0) return i === (n >> 1) ? T.DT_PORTAL : awn ? T.DT_SHOP_AWN : T.DT_SHOP;
          return f === b.floors - 1 ? T.DT_TOP : colTile[i % 10];
        }
        if (s === 2) return f === b.floors - 1 ? T.DT_TOP : f === 0 ? T.DT_BLANK : T.DT_WIN;
        return f > 0 && i % 2 === 1 ? T.DT_WIN : T.DT_BLANK;
      });
      const top = yF + b.floors * floorH;
      if (rng.chance(0.65)) {
        // mansard
        const k = 1.1, mh = 2.7, slate = rng.pick(PAL.slate);
        const o = rectPts(hw + 0.25, hd + 0.25), i2 = rectPts(hw - k, hd - k);
        for (let s = 0; s < 4; s++) {
          const a = o[s], bb = o[(s + 1) % 4], ia = i2[s], ib = i2[(s + 1) % 4];
          roofQuad(c.RT, xf, [[a[0], top, a[1]], [bb[0], top, bb[1]], [ib[0], top + mh, ib[1]], [ia[0], top + mh, ia[1]]], slate);
        }
        flatRoof(c, xf, i2, top + mh, rng.pick(PAL.flat));
        const nd = Math.max(1, Math.round(b.w / 5));
        for (let i = 0; i < nd; i++) dormer(c, xf, (i + 0.5) * (b.w / nd) - hw, hd - 0.35, top + 0.35, tint, slate, T.OT_ATTIC);
      } else {
        for (let s = 0; s < 4; s++) band(c, xf, pts[s][0], pts[s][1], pts[(s + 1) % 4][0], pts[(s + 1) % 4][1], top, top + 1.0, T.ST_BAND, tint, 0.14);
        flatRoof(c, xf, pts, top + 0.55, rng.pick(PAL.flat));
        boxL(c.RF, xf, rng.range(-hw * 0.4, hw * 0.4), top + 0.55, rng.range(-hd * 0.3, hd * 0.3), 1.6, 2.2, 1.4, [0.42, 0.42, 0.42]);
      }
      break;
    }
    case BKind.Office: {
      const tint = rng.pick(PAL.office);
      const style = rng.int(0, 2);
      foundation(c, xf, pts, b.y0, yF, T.OF_BLANK, tint);
      wallsPoly(c, xf, pts, yF, b.floors, fh, 3.6, rng, tint, acc, (s, f, i, n) => {
        if (f === 0) return s === 0 && i === (n >> 1) ? T.OF_ENTRANCE : T.OF_LOBBY;
        if (style === 0) return (f + i * 7 + s) % 5 === 0 ? T.OF_BLINDS : T.OF_SPANDREL;
        if (style === 1) return i === 0 || i === n - 1 ? T.OF_BLANK : T.OF_RIBBON;
        return (f * 3 + i) % 7 === 0 ? T.OF_BLINDS : T.OF_GLASS;
      });
      const top = yF + b.h;
      for (let s = 0; s < 4; s++) band(c, xf, pts[s][0], pts[s][1], pts[(s + 1) % 4][0], pts[(s + 1) % 4][1], top, top + 0.9, T.OF_BLANK, tint, 0.3);
      flatRoof(c, xf, pts, top + 0.5, rng.pick(PAL.flat));
      const nb = rng.int(1, 3);
      for (let i = 0; i < nb; i++) boxL(c.RF, xf, rng.range(-hw * 0.5, hw * 0.5), top + 0.5, rng.range(-hd * 0.5, hd * 0.5), rng.range(1.5, 4), rng.range(1.6, 3), rng.range(1.5, 3.5), [0.5, 0.5, 0.52]);
      break;
    }
    case BKind.Tower: {
      genTower(c, b, xf, rng);
      break;
    }
    case BKind.Apartment: {
      const tint = rng.pick(PAL.apartment);
      const colTile = Array.from({ length: 10 }, () => rng.pick([T.AP_WIN, T.AP_WIN, T.AP_BALC, T.AP_BALC, T.AP_PAIR, T.AP_AWN]));
      const flat = b.variant % 3 === 0;
      foundation(c, xf, pts, b.y0, yF, T.AP_BLANK, tint);
      wallsPoly(c, xf, pts, yF, b.floors, fh, 3.2, rng, tint, acc, (s, f, i, n) => {
        const mid = n >> 1;
        if (s === 0) {
          if (i === mid) return f === 0 ? T.AP_DOOR : T.AP_STAIR;
          if (f === 0) return i === 0 && n > 4 ? T.AP_GARAGE : T.AP_WIN;
          return colTile[i % 10];
        }
        if (s === 2) return f === 0 ? T.AP_WIN : colTile[(i + 5) % 10] === T.AP_AWN ? T.AP_WIN : colTile[(i + 5) % 10];
        return i % 2 === 0 ? T.AP_WIN : T.AP_BLANK;
      });
      const top = yF + b.h;
      if (flat) {
        for (let s = 0; s < 4; s++) band(c, xf, pts[s][0], pts[s][1], pts[(s + 1) % 4][0], pts[(s + 1) % 4][1], top, top + 0.7, T.AP_BLANK, tint, 0.25);
        flatRoof(c, xf, pts, top + 0.4, rng.pick(PAL.flat));
        boxL(c.RF, xf, 0, top + 0.4, 0, 1.5, 2.4, 1.5, [0.55, 0.55, 0.55]);
      } else {
        const yR = hipRoof(c, xf, hw, hd, top, rng.range(0.5, 0.62), 0.55, rng.pick(PAL.clay));
        if (rng.chance(0.7)) chimney(c, xf, rng.range(-hw * 0.4, hw * 0.4), 0, yR - 0.4, 1.3);
      }
      break;
    }
    case BKind.Villa: {
      const tint = rng.pick(PAL.villa);
      foundation(c, xf, pts, b.y0, yF, T.AP_BLANK, tint);
      wallsPoly(c, xf, pts, yF, b.floors, fh, 3.0, rng, tint, acc, (s, f, i, n) => {
        if (s === 0 && f === 0) return i === (n >> 1) ? T.AP_DOOR : T.VI_FRENCH;
        return (i + s) % 3 === 2 && s !== 0 ? T.AP_BLANK : T.VI_WIN;
      });
      const top = yF + b.h;
      const roofCol = rng.chance(0.7) ? rng.pick(PAL.clay) : rng.pick(PAL.slate);
      const yR = rng.chance(0.5) ? hipRoof(c, xf, hw, hd, top, 0.6, 0.6, roofCol) : gableRoof(c, xf, hw, hd, top, 0.7, 0.6, true, roofCol, T.AP_BLANK, tint);
      chimney(c, xf, hw * 0.4, -hd * 0.2, yR - 1.0, 1.6);
      break;
    }
    case BKind.Hall: {
      const tint = rng.pick(PAL.hall);
      const brick = rng.chance(0.3);
      foundation(c, xf, pts, b.y0, yF, T.IN_CONCRETE, tint);
      wallsPoly(c, xf, pts, yF, b.floors, fh, 4.6, rng, brick ? [1, 1, 1] : tint, acc, (s, f, i) => {
        if (brick) return f === 0 && s === 0 && i % 3 === 1 ? T.IN_ROLLER : f > 0 || i % 2 ? T.IN_BRICK_WIN : T.IN_BRICK;
        if (f === 0) return s === 0 ? (i % 3 === 1 ? T.IN_ROLLER : i % 3 === 2 ? T.IN_DOCK : T.IN_OFFICE) : T.IN_METAL;
        return (i + s) % 2 ? T.IN_STRIP : T.IN_METAL;
      });
      const top = yF + b.h;
      const roofCol: RGB = [0.5, 0.52, 0.55];
      if (b.variant % 3 === 0) {
        // sawtooth roof
        const teeth = Math.max(2, Math.round(b.w / 9));
        const tw = b.w / teeth;
        for (let i = 0; i < teeth; i++) {
          const x0 = -hw + i * tw, x1 = x0 + tw;
          roofQuad(c.RF, xf, [[x0, top, hd], [x0, top, -hd], [x1, top + 2.6, -hd], [x1, top + 2.6, hd]].reverse(), roofCol);
          band(c, xf, x1, hd, x1, -hd, top, top + 2.6, T.IN_STRIP, tint, 0.6, 4.6);
          gableTri(c, xf, [x0, top, hd], [x1, top, hd], [x1, top + 2.6, hd], T.IN_METAL, tint);
          gableTri(c, xf, [x1, top, -hd], [x0, top, -hd], [x1, top + 2.6, -hd], T.IN_METAL, tint);
        }
      } else if (b.variant % 3 === 1) {
        for (let s = 0; s < 4; s++) band(c, xf, pts[s][0], pts[s][1], pts[(s + 1) % 4][0], pts[(s + 1) % 4][1], top, top + 0.6, T.IN_METAL, tint, 0.2);
        flatRoof(c, xf, pts, top + 0.3, rng.pick(PAL.flat));
      } else gableRoof({ ...c, RT: c.RF }, xf, hw, hd, top, 0.22, 0.3, b.w > b.d, roofCol, T.IN_METAL, tint);
      if (rng.chance(0.25)) {
        // chimney stack / silo
        const sx = rng.range(-hw * 0.6, hw * 0.6), sz = -hd * 0.5;
        cone(c.RF, xf, sx, sz, 1.5, 1.2, top, top + rng.range(10, 20), 10, [0.62, 0.6, 0.58], 0);
      }
      break;
    }
    case BKind.Chalet:
    case BKind.Farm: {
      const timber = rng.pick(PAL.timber);
      const base: RGB = b.kind === BKind.Farm ? [0.9, 0.87, 0.8] : [0.82, 0.8, 0.76];
      foundation(c, xf, pts, b.y0, yF, T.CH_STONE, [1, 1, 1]);
      // ground floor: stone / plaster, upper floors timber
      wallsPoly(c, xf, pts, yF, 1, fh, 3.0, rng, base, acc, (s, _f, i, n) => (b.kind === BKind.Farm ? (s === 0 && i === (n >> 1) ? T.AP_DOOR : T.VI_WIN) : s === 0 && i === (n >> 1) ? T.CH_STONE_DOOR : i % 2 ? T.CH_STONE_WIN : T.CH_STONE));
      wallsPoly(c, xf, pts, yF + fh, b.floors - 1, fh, 3.0, rng, timber, acc, (s, f, i) => (s === 0 && f === 0 ? T.CH_BALC : (i + s + f) % 3 === 1 ? T.CH_TIMBER : T.CH_WIN));
      const top = yF + b.h;
      const roofCol = rng.chance(0.6) ? rng.pick(PAL.stoneRoof) : rng.pick(PAL.clay);
      const yR = gableRoof(c, xf, hw, hd, top, b.kind === BKind.Farm ? 0.62 : 0.48, 1.25, false, roofCol, T.CH_TIMBER, timber);
      chimney(c, xf, hw * 0.35, -hd * 0.3, yR - hw * 0.35 * 0.48 - 0.5, 1.5);
      break;
    }
    case BKind.Barn: {
      const timber = rng.pick(PAL.timber);
      foundation(c, xf, pts, b.y0, yF, T.CH_STONE, [1, 1, 1]);
      wallsPoly(c, xf, pts, yF, b.floors, fh, 4.0, rng, timber, acc, (s, f, i, n) => (s === 0 && f === 0 && i === (n >> 1) ? T.CH_BARN : T.CH_BARN));
      gableRoof(c, xf, hw, hd, yF + b.h, 0.7, 0.9, b.w > b.d, rng.pick(PAL.clay), T.CH_BARN, timber);
      break;
    }
    case BKind.Hospiz: {
      const tint: RGB = [0.88, 0.86, 0.8];
      foundation(c, xf, pts, b.y0, yF, T.CH_STONE, [1, 1, 1]);
      wallsPoly(c, xf, pts, yF, 1, fh, 3.0, rng, tint, hex(0x7a1f1f), (s, _f, i, n) => (s === 0 && i === (n >> 1) ? T.CH_STONE_DOOR : T.CH_STONE_WIN));
      wallsPoly(c, xf, pts, yF + fh, b.floors - 1, fh, 3.0, rng, tint, hex(0x7a1f1f), () => T.OT_SHUT);
      gableRoof(c, xf, hw, hd, yF + b.h, 0.6, 0.8, true, PAL.stoneRoof[0], T.OT_BLANK, tint);
      chimney(c, xf, hw * 0.5, 0, yF + b.h + hd * 0.6 - 0.6, 1.6);
      break;
    }
    case BKind.Station: genStation(c, b, xf, rng); break;
    case BKind.Church: genChurch(c, b, xf, rng); break;
    case BKind.Civic: genCivic(c, b, xf, rng); break;
    case BKind.Lookout: genLookout(c, b, xf); break;
    default: {
      foundation(c, xf, pts, b.y0, yF, T.RAW_CONCRETE, [1, 1, 1]);
      wallsPoly(c, xf, pts, yF, b.floors, fh, 3.2, rng, [0.8, 0.8, 0.8], acc, (s, f) => (s === 0 && f === 0 ? T.KIOSK : T.AP_BLANK));
      flatRoof(c, xf, pts, yF + b.h, PAL.flat[0]);
    }
  }
}

function chamfer(hw: number, hd: number, k: number): [number, number][] {
  return [[-hw + k, hd], [hw - k, hd], [hw, hd - k], [hw, -hd + k], [hw - k, -hd], [-hw + k, -hd], [-hw, -hd + k], [-hw, hd - k]];
}
function genTower(c: Ctx, b: Building, xf: Xf, rng: Rng): void {
  const hw = b.w / 2, hd = b.d / 2;
  const fh = b.h / b.floors;
  const glassTile = b.variant % 2 === 0 ? T.TW_GLASS_A : T.TW_GLASS_B;
  const tint: RGB = [0.8, 0.82, 0.84];
  foundation(c, xf, rectPts(hw, hd), b.y0, b.yF, T.RAW_CONCRETE, [1, 1, 1]);
  if (b.variant === 0) {
    // landmark: faceted plan that widens above the lower third
    const lowF = Math.round(b.floors * 0.3), upF = b.floors - lowF;
    const p0 = chamfer(hw * 0.86, hd * 0.86, 4.5), p1 = chamfer(hw, hd, 3.5);
    wallsPoly(c, xf, p0, b.yF, lowF, fh, 3.4, rng, tint, [1, 1, 1], (_s, f) => (f === 0 ? T.OF_LOBBY : glassTile));
    wallsPoly(c, xf, p1, b.yF + lowF * fh, upF, fh, 3.4, rng, tint, [1, 1, 1], () => glassTile);
    // soffit where the plan steps out
    flatRoof(c, xf, [...p1].reverse() as [number, number][], b.yF + lowF * fh, [0.2, 0.22, 0.22]);
    flatRoof(c, xf, p1, b.yF + b.h, PAL.flat[2]);
    boxL(c.RF, xf, 0, b.yF + b.h, 0, hw * 0.45, 3.2, hd * 0.45, [0.3, 0.32, 0.33]);
    boxL(c.RF, xf, hw * 0.2, b.yF + b.h + 3.2, 0, 0.12, 9, 0.12, [0.7, 0.7, 0.72]);
  } else {
    const pts = b.variant % 2 ? chamfer(hw, hd, 2.2) : rectPts(hw, hd);
    wallsPoly(c, xf, pts, b.yF, b.floors, fh, 3.4, rng, tint, [1, 1, 1], (s, f, i, n) => (f === 0 ? (s === 0 && i === (n >> 1) ? T.OF_ENTRANCE : T.OF_LOBBY) : f === b.floors - 1 ? T.OF_LOUVER : glassTile));
    flatRoof(c, xf, pts, b.yF + b.h, PAL.flat[0]);
    boxL(c.RF, xf, 0, b.yF + b.h, 0, hw * 0.4, 2.4, hd * 0.4, [0.36, 0.37, 0.38]);
  }
}

function genStation(c: Ctx, b: Building, xf: Xf, rng: Rng): void {
  const hw = b.w / 2, hd = b.d / 2;
  const tint = PAL.sandstone;
  const wallH = 13;
  const pts = rectPts(hw, hd);
  foundation(c, xf, pts, b.y0, b.yF, T.ST_BLANK, tint);
  // long hall: two storeys of arched windows; west end open dark arches for the tracks
  wallsPoly(c, xf, pts, b.yF, 2, wallH / 2, 6.2, rng, tint, [1, 1, 1], (s, f, i) => {
    if (s === 3) return f === 0 ? T.OT_ARCADE : T.ST_ARCH_WIN;
    if (f === 0) return i % 3 === 1 ? T.ST_PORTAL : T.ST_ARCH_WIN;
    return T.ST_ARCH_WIN;
  });
  for (let s = 0; s < 4; s++) band(c, xf, pts[s][0], pts[s][1], pts[(s + 1) % 4][0], pts[(s + 1) % 4][1], b.yF + wallH, b.yF + wallH + 1.6, T.ST_BAND, tint, 0.16, 6.2);
  // barrel vault roof
  const top = b.yF + wallH + 1.2, segs = 10, rise = 10;
  const roofCol: RGB = [0.5, 0.56, 0.6];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI, a1 = ((i + 1) / segs) * Math.PI;
    const z0 = Math.cos(a0) * hd, z1 = Math.cos(a1) * hd, y0 = top + Math.sin(a0) * rise, y1 = top + Math.sin(a1) * rise;
    roofQuad(c.RF, xf, [[-hw, y0, z0], [hw, y0, z0], [hw, y1, z1], [-hw, y1, z1]], i % 2 ? roofCol : [roofCol[0] * 0.85, roofCol[1] * 0.85, roofCol[2] * 0.9]);
    // end tympana
    c.atlas.rect(T.ST_BLANK, _r);
    c.F.color(tint[0], tint[1], tint[2], 1);
    c.F.accent(1, 1, 1, 1);
    const um = (_r[0] + _r[2]) / 2, vm = (_r[1] + _r[3]) / 2;
    c.F.tri(xf.X(hw, 0), top, xf.Z(hw, 0), xf.X(hw, z1), y1, xf.Z(hw, z1), xf.X(hw, z0), y0, xf.Z(hw, z0), um, vm, _r[0], _r[1], _r[2], _r[1]);
    c.F.tri(xf.X(-hw, 0), top, xf.Z(-hw, 0), xf.X(-hw, z0), y0, xf.Z(-hw, z0), xf.X(-hw, z1), y1, xf.Z(-hw, z1), um, vm, _r[0], _r[1], _r[2], _r[1]);
  }
  // triumphal-arch portal block on the south front, towards Bahnhofstrasse
  const px = 46, pw = 15, pd = 5, ph = 21;
  const pp: [number, number][] = [[px - pw, hd + pd], [px + pw, hd + pd], [px + pw, hd - 1], [px - pw, hd - 1]];
  for (let s = 0; s < 4; s++) {
    const a = pp[s], bb = pp[(s + 1) % 4];
    if (s === 0) {
      band(c, xf, a[0], a[1], a[0] + 8, a[1], b.yF, b.yF + 15, T.ST_PILASTER, tint, 1, 8);
      band(c, xf, a[0] + 8, a[1], bb[0] - 8, a[1], b.yF, b.yF + 15, T.ST_PORTAL, tint, 1, 14);
      band(c, xf, bb[0] - 8, a[1], bb[0], a[1], b.yF, b.yF + 15, T.ST_PILASTER, tint, 1, 8);
      band(c, xf, a[0], a[1], a[0] + 11, a[1], b.yF + 15, b.yF + ph, T.ST_BLANK, tint, 1, 11);
      band(c, xf, a[0] + 11, a[1], bb[0] - 11, a[1], b.yF + 15, b.yF + ph, T.ST_CLOCK, [1, 1, 1], 1, 8);
      band(c, xf, bb[0] - 11, a[1], bb[0], a[1], b.yF + 15, b.yF + ph, T.ST_BLANK, tint, 1, 11);
    } else band(c, xf, a[0], a[1], bb[0], bb[1], b.yF, b.yF + ph, T.ST_BLANK, tint, 1, 6);
    band(c, xf, a[0], a[1], bb[0], bb[1], b.yF + ph, b.yF + ph + 1.4, T.ST_BAND, tint, 0.16, 6);
  }
  flatRoof(c, xf, pp, b.yF + ph + 0.9, PAL.flat[1]);
  // flag pole + Swiss flag (red plane)
  boxL(c.RF, xf, px, b.yF + ph + 0.9, hd + 2, 0.08, 9, 0.08, [0.8, 0.8, 0.8]);
  boxL(c.RF, xf, px + 1.3, b.yF + ph + 7.4, hd + 2, 1.25, 2.4, 0.03, [0.85, 0.04, 0.05], 0);
}

function genChurch(c: Ctx, b: Building, xf: Xf, rng: Rng): void {
  const hw = b.w / 2, hd = b.d / 2;
  const v = b.variant;
  const tint: RGB = v === 3 ? [0.93, 0.91, 0.86] : v === 1 ? hex(0xbfb8a6) : v === 0 ? hex(0xc9c0aa) : hex(0xcfc6b0);
  const pts = rectPts(hw, hd);
  const wallH = b.h;
  foundation(c, xf, pts, b.y0, b.yF, T.ST_BLANK, tint);
  wallsPoly(c, xf, pts, b.yF, 1, wallH, 4.4, rng, tint, [1, 1, 1], (s, _f, i, n) => (s === 0 ? (i === (n >> 1) ? T.ST_PORTAL : T.ST_BLANK) : s === 2 ? T.ST_ROSE : T.ST_ARCH_WIN));
  const roofCol = v === 3 ? PAL.clay[1] : v === 1 ? PAL.slate[0] : PAL.clay[3];
  // nave roof: ridge along local z (long axis)
  const yRidge = gableRoof(c, xf, hw, hd, b.yF + wallH, 1.0, 0.3, false, roofCol, T.ST_ROSE, tint);
  const shaft = (lx: number, lz: number, half: number, height: number, clock: boolean) => {
    const p = rectPts(half, half, lx, lz);
    const levels = Math.max(2, Math.round(height / (half * 2.2)));
    const lh = height / levels;
    for (let s = 0; s < 4; s++) {
      const a = p[s], bb = p[(s + 1) % 4];
      for (let l = 0; l < levels; l++) {
        const tile = l === levels - 1 ? T.ST_BELFRY : clock && l === levels - 2 ? T.ST_CLOCK : l % 2 ? T.ST_ARCH_WIN : T.ST_BLANK;
        band(c, xf, a[0], a[1], bb[0], bb[1], b.yF + l * lh, b.yF + (l + 1) * lh, tile, tile === T.ST_CLOCK ? [1, 1, 1] : tint, 1, half * 2 + 1);
      }
      band(c, xf, a[0], a[1], bb[0], bb[1], b.yF + height, b.yF + height + 0.9, T.ST_BAND, tint, 0.16, half * 2 + 1);
    }
    return b.yF + height + 0.9;
  };
  if (v === 0) {
    // twin towers with lantern caps (Grossmünster-like)
    for (const sx of [-1, 1]) {
      const lx = sx * (hw - 4.2), lz = hd - 4.2;
      const y = shaft(lx, lz, 4.4, 44, false);
      cone(c.RF, xf, lx, lz, 4.9, 3.6, y, y + 4, 8, [0.6, 0.57, 0.5], Math.PI / 8);
      cone(c.RF, xf, lx, lz, 3.4, 3.2, y + 4, y + 9, 8, hex(0xb8b09a), Math.PI / 8);
      cone(c.RF, xf, lx, lz, 3.7, 2.2, y + 9, y + 12.5, 8, PAL.copper, Math.PI / 8);
      cone(c.RF, xf, lx, lz, 2.2, 0, y + 12.5, y + 17, 8, PAL.copper, Math.PI / 8);
    }
  } else if (v === 1) {
    // single slender tower with a tall copper spire (Fraumünster-like)
    const lx = -hw + 3.6, lz = hd - 3.6;
    const y = shaft(lx, lz, 3.8, 38, true);
    cone(c.RF, xf, lx, lz, 5.2, 1.3, y, y + 12, 4, PAL.copper);
    cone(c.RF, xf, lx, lz, 1.3, 0, y + 12, y + 34, 8, PAL.copper, Math.PI / 8);
  } else if (v === 2) {
    // broad tower with the big clock faces (St. Peter-like)
    const lx = 0, lz = hd - 4.6;
    const y = shaft(lx, lz, 5.0, 36, true);
    cone(c.RF, xf, lx, lz, 6.9, 0, y, y + 20, 4, PAL.slate[0]);
  } else {
    const lx = hw - 2.4, lz = hd - 2.4;
    const y = shaft(lx, lz, 2.4, 15, true);
    cone(c.RF, xf, lx, lz, 3.3, 0, y, y + 9, 4, PAL.clay[3]);
  }
  void yRidge;
}

function genCivic(c: Ctx, b: Building, xf: Xf, rng: Rng): void {
  const hw = b.w / 2, hd = b.d / 2;
  const pts = rectPts(hw, hd);
  const fh = b.h / b.floors;
  if (b.variant === 2) {
    // hospital: modern white slab
    const tint: RGB = [0.92, 0.93, 0.93];
    foundation(c, xf, pts, b.y0, b.yF, T.RAW_CONCRETE, [1, 1, 1]);
    wallsPoly(c, xf, pts, b.yF, b.floors, fh, 3.6, rng, tint, hex(0xc81e2a), (s, f, i, n) => (f === 0 ? (s === 0 && i === (n >> 1) ? T.OF_ENTRANCE : T.OF_LOBBY) : T.HOSP_STRIP));
    for (let s = 0; s < 4; s++) band(c, xf, pts[s][0], pts[s][1], pts[(s + 1) % 4][0], pts[(s + 1) % 4][1], b.yF + b.h, b.yF + b.h + 0.8, T.OF_BLANK, tint, 0.3);
    flatRoof(c, xf, pts, b.yF + b.h + 0.4, PAL.flat[1]);
    boxL(c.RF, xf, hw * 0.5, b.yF + b.h + 0.4, 0, 4, 2.6, 3, [0.6, 0.6, 0.6]);
    return;
  }
  const tint = b.variant === 0 ? hex(0xd8cdb4) : hex(0xcfc6ae);
  foundation(c, xf, pts, b.y0, b.yF, T.ST_BLANK, tint);
  wallsPoly(c, xf, pts, b.yF, b.floors, fh, 4.2, rng, tint, [1, 1, 1], (s, f, i, n) => {
    if (f === 0) return s === 0 && Math.abs(i - (n >> 1)) <= 1 ? T.ST_PORTAL : T.ST_BLANK;
    return s === 0 || s === 2 ? T.ST_PILASTER : T.ST_ARCH_WIN;
  });
  for (let s = 0; s < 4; s++) band(c, xf, pts[s][0], pts[s][1], pts[(s + 1) % 4][0], pts[(s + 1) % 4][1], b.yF + b.h, b.yF + b.h + 1.5, T.ST_BAND, tint, 0.16, 4.2);
  const top = b.yF + b.h + 1.5;
  if (b.variant === 0) {
    hipRoof(c, xf, hw - 0.5, hd - 0.5, top - 0.4, 0.45, 0, PAL.copper, c.RF);
  } else {
    hipRoof(c, xf, hw - 0.5, hd - 0.5, top - 0.4, 0.3, 0, PAL.slate[1]);
    // central dome
    cone(c.RF, xf, 0, 0, 9.5, 9.5, top, top + 7, 12, tint, 0);
    cone(c.RF, xf, 0, 0, 10, 7.6, top + 7, top + 11.5, 12, PAL.copper, 0);
    cone(c.RF, xf, 0, 0, 7.6, 3.4, top + 11.5, top + 14.5, 12, PAL.copper, 0);
    cone(c.RF, xf, 0, 0, 3.4, 0, top + 14.5, top + 16, 12, PAL.copper, 0);
    cone(c.RF, xf, 0, 0, 1.0, 0.8, top + 15.6, top + 18.4, 8, tint, 0);
    cone(c.RF, xf, 0, 0, 1.2, 0, top + 18.4, top + 20, 8, PAL.copper, 0);
  }
}

function genLookout(c: Ctx, b: Building, xf: Xf): void {
  const steel: RGB = [0.5, 0.52, 0.54];
  const H = b.h;
  // tapered lattice mast approximated by four legs + braces
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    for (let k = 0; k < 5; k++) {
      const y0 = b.yF + (H * k) / 5, t0 = k / 5, t1 = (k + 1) / 5;
      const r0 = 3.2 - 2.0 * t0, r1 = 3.2 - 2.0 * t1;
      boxL(c.RF, xf, sx * (r0 + r1) / 2, y0, sz * (r0 + r1) / 2, 0.16, H / 5, 0.16, steel);
      boxL(c.RF, xf, 0, y0 + H / 5 - 0.12, sz * r1, r1, 0.12, 0.07, steel);
      boxL(c.RF, xf, sx * r1, y0 + H / 5 - 0.12, 0, 0.07, 0.12, r1, steel);
    }
  }
  boxL(c.RF, xf, 0, b.yF, 0, 0.9, H, 0.9, [0.42, 0.44, 0.46]);
  boxL(c.RF, xf, 0, b.yF + H * 0.78, 0, 3.6, 0.25, 3.6, [0.36, 0.37, 0.38]);
  for (const [sx, sz, hx, hz] of [[0, 1, 3.6, 0.05], [0, -1, 3.6, 0.05], [1, 0, 0.05, 3.6], [-1, 0, 0.05, 3.6]]) boxL(c.RF, xf, sx * 3.55, b.yF + H * 0.78 + 0.25, sz * 3.55, hx, 1.1, hz, steel);
  boxL(c.RF, xf, 0, b.yF + H, 0, 0.1, 12, 0.1, [0.75, 0.2, 0.18]);
}

// ====================================================================== view
interface ChunkState { list: Building[]; meshes: THREE.Mesh[]; built: boolean; center: THREE.Vector3; radius: number }

export class BuildingsView {
  readonly group = new THREE.Group();
  readonly atlas: FacadeAtlas;
  private mTile: THREE.MeshStandardMaterial;
  private mFlat: THREE.MeshStandardMaterial;
  private chunks: ChunkState[] = [];

  constructor(private world: World, private quality: Quality) {
    this.atlas = buildFacadeAtlas(quality.name === 'low' ? 1024 : 2048, quality.anisotropy);
    const tiles = makeRoofTiles(256), flat = makeFlatRoof(256);
    const snow = (m: THREE.MeshStandardMaterial, key: string) =>
      patchMaterial(m, key, (sh) => {
        sh.uniforms.uSnow = U.uSnow;
        sh.uniforms.uWet = U.uWet;
        sh.vertexShader = replaceOnce(sh.vertexShader, '#include <common>', '#include <common>\nvarying float vUp;');
        sh.vertexShader = replaceOnce(sh.vertexShader, '#include <begin_vertex>', '#include <begin_vertex>\nvUp = normalize(mat3(modelMatrix) * normal).y;');
        sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <common>', '#include <common>\nuniform float uSnow; uniform float uWet;\nvarying float vUp;');
        sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.94), uSnow * smoothstep(0.35, 0.8, vUp));
diffuseColor.rgb *= 1.0 - uWet * 0.25;`);
        sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, uWet * 0.7);');
      });
    this.mTile = new THREE.MeshStandardMaterial({ map: tiles.map, normalMap: tiles.normal, roughness: 0.82, metalness: 0, vertexColors: true });
    snow(this.mTile, 'roof-tile');
    this.mFlat = new THREE.MeshStandardMaterial({ map: flat.map, normalMap: flat.normal, roughness: 0.8, metalness: 0.05, vertexColors: true });
    snow(this.mFlat, 'roof-flat');
    for (const t of [tiles, flat]) { t.map.anisotropy = quality.anisotropy; t.normal.anisotropy = quality.anisotropy; }
    for (let i = 0; i < CHUNKS * CHUNKS; i++) {
      this.chunks.push({ list: [], meshes: [], built: false, center: new THREE.Vector3(((i % CHUNKS) + 0.5) * CHUNK - WORLD_HALF, 0, (Math.floor(i / CHUNKS) + 0.5) * CHUNK - WORLD_HALF), radius: CHUNK * 0.75 });
    }
    for (const b of world.city.buildings) {
      const cx = clamp(Math.floor((b.x + WORLD_HALF) / CHUNK), 0, CHUNKS - 1), cz = clamp(Math.floor((b.z + WORLD_HALF) / CHUNK), 0, CHUNKS - 1);
      this.chunks[cz * CHUNKS + cx].list.push(b);
    }
  }

  private build(ch: ChunkState): void {
    ch.built = true;
    if (!ch.list.length) return;
    const ctx: Ctx = { F: new MeshBuilder({ accent: true, normUv: true }), RT: new MeshBuilder({ floatColor: false }), RF: new MeshBuilder({ floatColor: false }), atlas: this.atlas };
    for (const b of ch.list) genBuilding(ctx, b);
    const add = (mb: MeshBuilder, mat: THREE.Material) => {
      if (mb.empty) return;
      const mesh = new THREE.Mesh(mb.build(), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      ch.meshes.push(mesh);
    };
    add(ctx.F, this.atlas.material);
    add(ctx.RT, this.mTile);
    add(ctx.RF, this.mFlat);
  }

  update(cam: THREE.Vector3, viewDist: number, budgetMs = 5): number {
    const t0 = performance.now();
    let pending = 0;
    let best: ChunkState | null = null, bestD = 1e12;
    for (const ch of this.chunks) {
      if (!ch.list.length) continue;
      const dx = Math.max(0, Math.abs(cam.x - ch.center.x) - CHUNK / 2), dz = Math.max(0, Math.abs(cam.z - ch.center.z) - CHUNK / 2);
      const d = Math.sqrt(dx * dx + dz * dz);
      const vis = d < viewDist;
      if (!ch.built && vis) {
        pending++;
        if (d < bestD) { bestD = d; best = ch; }
      }
      for (const m of ch.meshes) m.visible = vis;
    }
    while (best && performance.now() - t0 < budgetMs) {
      this.build(best);
      pending--;
      best = null;
      bestD = 1e12;
      for (const ch of this.chunks) {
        if (ch.built || !ch.list.length) continue;
        const d = Math.hypot(cam.x - ch.center.x, cam.z - ch.center.z);
        if (d < viewDist && d < bestD) { bestD = d; best = ch; }
      }
    }
    return pending;
  }
}
