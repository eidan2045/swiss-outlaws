// Procedurally painted facade atlas: 8x8 tiles (one bay x one floor each) with albedo, tint/accent masks,
// window-light mask, roughness/metalness and a derived normal map.
import * as THREE from 'three';
import { Rng } from '../../shared/math';
import { U, patchMaterial, replaceOnce } from './globals';
import { dataTexture, fbmField, makeCanvas, noiseField } from './textures';

export const ATLAS_TILES = 8;

/** Tile ids = row * 8 + col. */
export const T = {
  // row 0: old town plaster
  OT_SHUT: 0, OT_FLOWER: 1, OT_PLAIN: 2, OT_BLANK: 3, OT_DOOR: 4, OT_SHOP: 5, OT_ARCADE: 6, OT_ATTIC: 7,
  // row 1: downtown stone
  DT_WIN: 8, DT_BALC: 9, DT_PAIR: 10, DT_BLANK: 11, DT_PORTAL: 12, DT_SHOP_AWN: 13, DT_SHOP: 14, DT_TOP: 15,
  // row 2: modern office
  OF_GLASS: 16, OF_SPANDREL: 17, OF_RIBBON: 18, OF_BLANK: 19, OF_ENTRANCE: 20, OF_LOBBY: 21, OF_LOUVER: 22, OF_BLINDS: 23,
  // row 3: apartment
  AP_WIN: 24, AP_BALC: 25, AP_PAIR: 26, AP_BLANK: 27, AP_DOOR: 28, AP_GARAGE: 29, AP_STAIR: 30, AP_AWN: 31,
  // row 4: villa / chalet
  VI_WIN: 32, VI_FRENCH: 33, CH_TIMBER: 34, CH_WIN: 35, CH_BALC: 36, CH_STONE: 37, CH_STONE_DOOR: 38, CH_BARN: 39,
  // row 5: industrial
  IN_METAL: 40, IN_STRIP: 41, IN_ROLLER: 42, IN_BRICK: 43, IN_BRICK_WIN: 44, IN_CONCRETE: 45, IN_DOCK: 46, IN_OFFICE: 47,
  // row 6: sandstone landmarks
  ST_BLANK: 48, ST_ARCH_WIN: 49, ST_PORTAL: 50, ST_PILASTER: 51, ST_CLOCK: 52, ST_ROSE: 53, ST_BAND: 54, ST_BELFRY: 55,
  // row 7: misc
  TW_GLASS_A: 56, TW_GLASS_B: 57, KIOSK: 58, HOSP_STRIP: 59, RAW_CONCRETE: 60, SHOWROOM: 61, CH_STONE_WIN: 62, WHITE: 63,
};

export interface FacadeAtlas {
  material: THREE.MeshStandardMaterial;
  albedo: THREE.DataTexture;
  size: number;
  /** uv rect [u0, vTop, u1, vBottom] for a tile */
  rect(tile: number, out: number[]): number[];
}

interface Pen {
  rect(x: number, y: number, w: number, h: number, o: Fill): void;
  ellipse(cx: number, cy: number, rx: number, ry: number, o: Fill, half?: boolean): void;
}
interface Fill {
  c?: string; // albedo colour
  tint?: number; // wall tint mask 0..1
  acc?: number; // accent mask 0..1
  h?: number; // height 0..1
  em?: number; // window light mask
  r?: number; // roughness
  m?: number; // metalness
}

export function buildFacadeAtlas(size: number, anisotropy: number): FacadeAtlas {
  const TS = size / ATLAS_TILES;
  const [cC, C] = makeCanvas(size, size); // colour
  const [cM, M] = makeCanvas(size, size); // masks: r tint, g accent
  const [cH, H] = makeCanvas(size, size); // height
  const [cP, P] = makeCanvas(size, size); // props: r emissive, g roughness, b metal
  C.fillStyle = '#ffffff'; C.fillRect(0, 0, size, size);
  M.fillStyle = 'rgb(255,0,0)'; M.fillRect(0, 0, size, size);
  H.fillStyle = 'rgb(150,150,150)'; H.fillRect(0, 0, size, size);
  P.fillStyle = 'rgb(0,235,0)'; P.fillRect(0, 0, size, size);
  const b = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

  const penFor = (tile: number): Pen => {
    const ox = (tile % ATLAS_TILES) * TS, oy = Math.floor(tile / ATLAS_TILES) * TS;
    const apply = (o: Fill, draw: (ctx: CanvasRenderingContext2D) => void) => {
      if (o.c !== undefined) { C.fillStyle = o.c; draw(C); }
      if (o.tint !== undefined || o.acc !== undefined) { M.fillStyle = `rgb(${b(o.tint ?? 0)},${b(o.acc ?? 0)},0)`; draw(M); }
      else if (o.c !== undefined && o.c.length <= 7) { M.fillStyle = 'rgb(0,0,0)'; draw(M); }
      if (o.h !== undefined) { const v = b(o.h); H.fillStyle = `rgb(${v},${v},${v})`; draw(H); }
      if (o.em !== undefined || o.r !== undefined || o.m !== undefined) { P.fillStyle = `rgb(${b(o.em ?? 0)},${b(o.r ?? 0.9)},${b(o.m ?? 0)})`; draw(P); }
    };
    return {
      rect(x, y, w, h, o) {
        const X = Math.round(ox + x * TS), Y = Math.round(oy + y * TS), W = Math.max(1, Math.round(w * TS)), Hh = Math.max(1, Math.round(h * TS));
        apply(o, (ctx) => ctx.fillRect(X, Y, W, Hh));
      },
      ellipse(cx, cy, rx, ry, o, half = false) {
        apply(o, (ctx) => {
          ctx.beginPath();
          ctx.ellipse(ox + cx * TS, oy + cy * TS, rx * TS, ry * TS, 0, half ? Math.PI : 0, Math.PI * 2);
          ctx.fill();
        });
      },
    };
  };

  // ---------------------------------------------------------------- primitives
  const GLASS_T = '#31404f', GLASS_B = '#161d26';
  const glass = (p: Pen, x: number, y: number, w: number, h: number, o: { modern?: boolean; em?: number; blinds?: number; curtain?: string } = {}) => {
    const m = o.modern ? 0.86 : 0.62;
    p.rect(x, y, w, h * 0.5, { c: o.modern ? '#5a6f82' : GLASS_T, h: 0.3, em: o.em ?? 1, r: 0.07, m });
    p.rect(x, y + h * 0.5, w, h * 0.5, { c: o.modern ? '#46586a' : GLASS_B, h: 0.3, em: o.em ?? 1, r: 0.07, m });
    if (o.curtain) {
      p.rect(x, y, w * 0.2, h, { c: o.curtain, h: 0.32, em: 0.75, r: 0.8, m: 0 });
      p.rect(x + w * 0.8, y, w * 0.2, h, { c: o.curtain, h: 0.32, em: 0.75, r: 0.8, m: 0 });
    }
    if (o.blinds) {
      const bh = h * o.blinds;
      for (let i = 0; i < 9; i++) {
        const yy = y + (bh * i) / 9;
        p.rect(x, yy, w, bh / 9 * 0.8, { c: i % 2 ? '#c9c6bd' : '#dcd9d0', h: 0.4, em: 0.25, r: 0.7, m: 0 });
      }
    }
  };
  const frameWin = (p: Pen, x: number, y: number, w: number, h: number, o: { frame?: string; fw?: number; cols?: number; rows?: number; sill?: boolean; lintel?: boolean; curtain?: string; modern?: boolean; blinds?: number; arch?: boolean } = {}) => {
    const fw = o.fw ?? 0.018, fc = o.frame ?? '#ece8dc';
    // recess shadow
    p.rect(x - 0.012, y - 0.012, w + 0.024, h + 0.024, { c: '#5b5850', h: 0.42, r: 0.9 });
    if (o.arch) p.ellipse(x + w / 2, y, w / 2 + 0.012, w * 0.36 + 0.012, { c: '#5b5850', h: 0.42, r: 0.9 }, true);
    p.rect(x, y, w, h, { c: fc, h: 0.52, r: 0.55 });
    if (o.arch) {
      p.ellipse(x + w / 2, y, w / 2, w * 0.36, { c: fc, h: 0.52, r: 0.55 }, true);
      p.ellipse(x + w / 2, y, w / 2 - fw, w * 0.36 - fw, { c: GLASS_T, h: 0.3, em: 1, r: 0.07, m: 0.62 }, true);
    }
    glass(p, x + fw, y + fw, w - 2 * fw, h - 2 * fw, { modern: o.modern, curtain: o.curtain, blinds: o.blinds });
    const cols = o.cols ?? 2, rows = o.rows ?? 2;
    for (let i = 1; i < cols; i++) p.rect(x + (w * i) / cols - fw * 0.4, y, fw * 0.8, h, { c: fc, h: 0.5, r: 0.55 });
    for (let i = 1; i < rows; i++) p.rect(x, y + (h * i) / rows - fw * 0.4, w, fw * 0.8, { c: fc, h: 0.5, r: 0.55 });
    if (o.sill !== false) {
      p.rect(x - 0.03, y + h, w + 0.06, 0.028, { c: '#cfc9bb', h: 0.9, r: 0.8 });
      p.rect(x - 0.02, y + h + 0.028, w + 0.04, 0.05, { c: '#8f8a80', tint: 0.6, h: 0.55, r: 0.9 }); // drip stain
    }
    if (o.lintel) p.rect(x - 0.035, y - 0.05 - (o.arch ? w * 0.36 : 0), w + 0.07, 0.04, { c: '#d6d0c2', h: 0.88, r: 0.8 });
  };
  const shutters = (p: Pen, x: number, y: number, w: number, h: number) => {
    const sw = w * 0.42;
    for (const sx of [x - sw - 0.012, x + w + 0.012]) {
      p.rect(sx, y, sw, h, { c: '#dedede', acc: 1, h: 0.74, r: 0.7 });
      for (let i = 0; i < 12; i++) p.rect(sx + 0.01, y + (h * i) / 12 + 0.004, sw - 0.02, h / 12 * 0.45, { c: '#a9a9a9', acc: 1, h: 0.66, r: 0.7 });
      p.rect(sx, y + h * 0.48, sw, 0.012, { c: '#c8c8c8', acc: 1, h: 0.78, r: 0.7 });
    }
  };
  const flowerBox = (p: Pen, x: number, y: number, w: number, rng: Rng) => {
    p.rect(x - 0.02, y, w + 0.04, 0.05, { c: '#5a3b22', h: 0.92, r: 0.85 });
    for (let i = 0; i < 26; i++) {
      const fx = x - 0.02 + rng.next() * (w + 0.04), fy = y - 0.035 + rng.next() * 0.05;
      p.ellipse(fx, fy, 0.016, 0.014, { c: rng.chance(0.62) ? (rng.chance(0.75) ? '#c2182a' : '#e04a6a') : '#3f7a2e', h: 0.95, r: 0.8 });
    }
  };
  const blocks = (p: Pen, x: number, y: number, w: number, h: number, bw: number, bh: number, rng: Rng, joint = '#9d978b', tint = 1) => {
    p.rect(x, y, w, h, { c: '#ffffff', tint, h: 0.62, r: 0.9 });
    let row = 0;
    for (let yy = y; yy < y + h - 0.001; yy += bh, row++) {
      p.rect(x, yy, w, 0.007, { c: joint, tint: tint * 0.7, h: 0.4, r: 0.95 });
      for (let xx = x + ((row % 2) * bw) / 2; xx < x + w; xx += bw) {
        p.rect(xx, yy, 0.007, Math.min(bh, y + h - yy), { c: joint, tint: tint * 0.7, h: 0.4, r: 0.95 });
        if (rng.chance(0.3)) p.rect(xx + 0.007, yy + 0.007, Math.min(bw, x + w - xx) - 0.007, Math.min(bh, y + h - yy) - 0.007, { c: rng.chance(0.5) ? '#f1efe9' : '#e2dfd6', tint, h: 0.6 + rng.next() * 0.06, r: 0.9 });
      }
    }
  };
  const planksH = (p: Pen, x: number, y: number, w: number, h: number, rng: Rng, n = 12) => {
    for (let i = 0; i < n; i++) {
      const v = 200 + Math.round(rng.next() * 45);
      p.rect(x, y + (h * i) / n, w, h / n, { c: `rgb(${v},${v},${v})`, tint: 1, h: 0.58 + rng.next() * 0.08, r: 0.86 });
      p.rect(x, y + (h * i) / n, w, 0.006, { c: '#6f6f6f', tint: 1, h: 0.36, r: 0.95 });
    }
  };
  const planksV = (p: Pen, x: number, y: number, w: number, h: number, rng: Rng, n = 14) => {
    for (let i = 0; i < n; i++) {
      const v = 195 + Math.round(rng.next() * 50);
      p.rect(x + (w * i) / n, y, w / n, h, { c: `rgb(${v},${v},${v})`, tint: 1, h: 0.58 + rng.next() * 0.08, r: 0.86 });
      p.rect(x + (w * i) / n, y, 0.006, h, { c: '#6a6a6a', tint: 1, h: 0.36, r: 0.95 });
    }
  };
  const rubble = (p: Pen, rng: Rng) => {
    p.rect(0, 0, 1, 1, { c: '#8a867c', h: 0.4, r: 0.95 });
    for (let i = 0; i < 90; i++) {
      const v = 150 + Math.round(rng.next() * 70);
      p.ellipse(rng.next(), rng.next(), 0.035 + rng.next() * 0.05, 0.028 + rng.next() * 0.03, { c: `rgb(${v},${v - 4},${v - 12})`, h: 0.6 + rng.next() * 0.15, r: 0.92 });
    }
  };
  const door = (p: Pen, x: number, w: number, top: number, col: string, o: { glass?: boolean; frame?: string; arch?: boolean } = {}) => {
    p.rect(x - 0.03, top - 0.03, w + 0.06, 1 - top + 0.03, { c: o.frame ?? '#cfc9bb', h: 0.8, r: 0.8 });
    if (o.arch) p.ellipse(x + w / 2, top, w / 2 + 0.03, w * 0.4 + 0.03, { c: o.frame ?? '#cfc9bb', h: 0.8, r: 0.8 }, true);
    p.rect(x, top, w, 1 - top, { c: col, h: 0.36, r: 0.6 });
    if (o.arch) p.ellipse(x + w / 2, top, w / 2, w * 0.4, { c: col, h: 0.36, r: 0.6 }, true);
    p.rect(x + w / 2 - 0.004, top, 0.008, 1 - top, { c: '#1c1612', h: 0.25, r: 0.7 });
    if (o.glass) {
      glass(p, x + 0.03, top + 0.04, w / 2 - 0.045, (1 - top) * 0.62, {});
      glass(p, x + w / 2 + 0.015, top + 0.04, w / 2 - 0.045, (1 - top) * 0.62, {});
    } else {
      for (const dx of [0.03, w / 2 + 0.02]) {
        p.rect(x + dx, top + 0.05, w / 2 - 0.05, (1 - top) * 0.38, { c: '#00000028', h: 0.3 });
        p.rect(x + dx, top + 0.1 + (1 - top) * 0.4, w / 2 - 0.05, (1 - top) * 0.4, { c: '#00000028', h: 0.3 });
      }
    }
    p.rect(x + w / 2 + 0.02, top + (1 - top) * 0.52, 0.02, 0.012, { c: '#c9a94a', h: 0.5, r: 0.3, m: 0.9 });
  };
  const shop = (p: Pen, o: { frame: string; sign?: boolean; awning?: boolean; base?: string }) => {
    p.rect(0, 0.84, 1, 0.16, { c: o.base ?? '#8d877b', tint: 0.35, h: 0.72, r: 0.9 });
    p.rect(0.05, 0.2, 0.9, 0.66, { c: o.frame, h: 0.5, r: 0.5 });
    glass(p, 0.08, 0.23, 0.84, 0.6, { em: 1 });
    // display hints
    p.rect(0.12, 0.6, 0.76, 0.23, { c: '#3a4350', h: 0.3, em: 1, r: 0.08, m: 0.5 });
    p.rect(0.495, 0.23, 0.012, 0.6, { c: o.frame, h: 0.5, r: 0.5 });
    if (o.sign) {
      p.rect(0.04, 0.05, 0.92, 0.12, { c: '#e9e9e9', acc: 1, h: 0.8, r: 0.6 });
      p.rect(0.2, 0.09, 0.6, 0.04, { c: '#f8f8f4', h: 0.84, em: 0.5, r: 0.5 });
    }
    if (o.awning) {
      p.rect(0.02, 0.13, 0.96, 0.1, { c: '#e6e6e6', acc: 1, h: 0.95, r: 0.8 });
      for (let i = 0; i < 8; i++) if (i % 2) p.rect(0.02 + (0.96 * i) / 8, 0.13, 0.12, 0.1, { c: '#fbfbfb', acc: 0.25, h: 0.95, r: 0.8 });
      p.rect(0.02, 0.23, 0.96, 0.02, { c: '#00000050', h: 0.4 });
    }
  };
  const cornice = (p: Pen, y: number, h: number, c = '#d8d2c4') => {
    p.rect(0, y, 1, h, { c, tint: 0.5, h: 0.92, r: 0.85 });
    p.rect(0, y + h, 1, 0.014, { c: '#00000045', h: 0.5 });
  };

  // ---------------------------------------------------------------- tiles
  const rng = new Rng(4711);
  const P_ = penFor;
  // --- row 0: old town
  { const p = P_(T.OT_SHUT); frameWin(p, 0.34, 0.24, 0.32, 0.5, { curtain: '#e6dfcf' }); shutters(p, 0.34, 0.24, 0.32, 0.5); }
  { const p = P_(T.OT_FLOWER); frameWin(p, 0.34, 0.24, 0.32, 0.5, { curtain: '#d9cdb8' }); shutters(p, 0.34, 0.24, 0.32, 0.5); flowerBox(p, 0.34, 0.74, 0.32, rng); }
  { const p = P_(T.OT_PLAIN); p.rect(0.29, 0.19, 0.42, 0.62, { c: '#d9d3c5', h: 0.7, r: 0.85 }); frameWin(p, 0.33, 0.23, 0.34, 0.52, { curtain: '#ece6d8', lintel: false }); }
  { const p = P_(T.OT_BLANK); p.rect(0.2, 0.3, 0.3, 0.5, { c: '#f4f2ec', tint: 1, h: 0.61 }); }
  { const p = P_(T.OT_DOOR); p.rect(0, 0.86, 1, 0.14, { c: '#8d877b', tint: 0.35, h: 0.72, r: 0.9 }); door(p, 0.33, 0.34, 0.22, '#4b3020', { arch: true }); }
  { const p = P_(T.OT_SHOP); shop(p, { frame: '#3c2a1c', sign: true }); }
  { const p = P_(T.OT_ARCADE); p.rect(0, 0.86, 1, 0.14, { c: '#8d877b', tint: 0.35, h: 0.72, r: 0.9 }); p.rect(0.14, 0.34, 0.72, 0.66, { c: '#15120f', h: 0.1, r: 1 }); p.ellipse(0.5, 0.34, 0.36, 0.22, { c: '#15120f', h: 0.1, r: 1 }, true); p.rect(0.3, 0.5, 0.4, 0.5, { c: '#2a2520', h: 0.14, em: 0.6, r: 0.6 }); }
  { const p = P_(T.OT_ATTIC); cornice(p, 0, 0.07); frameWin(p, 0.38, 0.3, 0.24, 0.36, { curtain: '#e6dfcf' }); shutters(p, 0.38, 0.3, 0.24, 0.36); }
  // --- row 1: downtown stone
  const dtBase = (tile: number) => { const p = P_(tile); blocks(p, 0, 0, 1, 1, 0.34, 0.125, rng, '#aaa497', 1); return p; };
  { const p = dtBase(T.DT_WIN); p.rect(0.27, 0.14, 0.46, 0.72, { c: '#e9e4d8', tint: 0.5, h: 0.76, r: 0.85 }); frameWin(p, 0.32, 0.22, 0.36, 0.56, { rows: 3, curtain: '#efe9dc', lintel: true }); p.rect(0.3, 0.1, 0.4, 0.05, { c: '#dcd6c8', tint: 0.4, h: 0.94 }); }
  { const p = dtBase(T.DT_BALC); p.rect(0.27, 0.12, 0.46, 0.8, { c: '#e9e4d8', tint: 0.5, h: 0.76, r: 0.85 }); frameWin(p, 0.32, 0.18, 0.36, 0.68, { rows: 3, sill: false, curtain: '#efe9dc' }); p.rect(0.2, 0.86, 0.6, 0.05, { c: '#b9b3a6', h: 0.98, r: 0.85 }); for (let i = 0; i < 13; i++) p.rect(0.2 + (0.6 * i) / 12 - 0.004, 0.64, 0.008, 0.22, { c: '#22252a', h: 0.97, r: 0.4, m: 0.8 }); p.rect(0.2, 0.63, 0.6, 0.014, { c: '#22252a', h: 0.98, r: 0.4, m: 0.8 }); }
  { const p = dtBase(T.DT_PAIR); for (const x of [0.13, 0.55]) { p.rect(x - 0.03, 0.18, 0.38, 0.66, { c: '#e9e4d8', tint: 0.5, h: 0.76 }); frameWin(p, x, 0.24, 0.32, 0.52, { rows: 3, curtain: '#e8e2d4' }); } }
  dtBase(T.DT_BLANK);
  { const p = P_(T.DT_PORTAL); blocks(p, 0, 0, 1, 1, 0.5, 0.2, rng, '#8f897d', 0.85); door(p, 0.28, 0.44, 0.24, '#3a2618', { arch: true, frame: '#d8d2c4' }); }
  { const p = P_(T.DT_SHOP_AWN); blocks(p, 0, 0, 1, 0.2, 0.5, 0.2, rng, '#8f897d', 0.85); shop(p, { frame: '#23262b', awning: true, base: '#6d6a64' }); }
  { const p = P_(T.DT_SHOP); blocks(p, 0, 0, 1, 0.2, 0.5, 0.2, rng, '#8f897d', 0.85); shop(p, { frame: '#23262b', sign: true, base: '#6d6a64' }); }
  { const p = dtBase(T.DT_TOP); cornice(p, 0, 0.1, '#e2dccf'); cornice(p, 0.1, 0.035, '#c9c3b5'); frameWin(p, 0.34, 0.3, 0.32, 0.46, { rows: 2, curtain: '#efe9dc', lintel: true }); }
  // --- row 2: modern office
  const mull = (p: Pen, c = '#2a2e33') => { p.rect(0, 0, 0.02, 1, { c, h: 0.6, r: 0.4, m: 0.7 }); p.rect(0.98, 0, 0.02, 1, { c, h: 0.6, r: 0.4, m: 0.7 }); p.rect(0, 0, 1, 0.018, { c, h: 0.6, r: 0.4, m: 0.7 }); p.rect(0.49, 0, 0.02, 1, { c, h: 0.55, r: 0.4, m: 0.7 }); };
  { const p = P_(T.OF_GLASS); glass(p, 0, 0, 1, 1, { modern: true }); mull(p); }
  { const p = P_(T.OF_SPANDREL); glass(p, 0, 0, 1, 0.7, { modern: true }); p.rect(0, 0.7, 1, 0.3, { c: '#39414a', h: 0.5, r: 0.25, m: 0.7 }); mull(p); }
  { const p = P_(T.OF_RIBBON); p.rect(0, 0, 1, 1, { c: '#ffffff', tint: 1, h: 0.62, r: 0.7 }); p.rect(0, 0.26, 1, 0.48, { c: '#2a2e33', h: 0.5, r: 0.4, m: 0.6 }); glass(p, 0.01, 0.28, 0.98, 0.44, { modern: true }); p.rect(0.495, 0.26, 0.012, 0.48, { c: '#2a2e33', h: 0.5 }); p.rect(0, 0.985, 1, 0.015, { c: '#00000030', h: 0.5 }); }
  { const p = P_(T.OF_BLANK); p.rect(0, 0, 1, 1, { c: '#ffffff', tint: 1, h: 0.62, r: 0.7 }); p.rect(0, 0.5, 1, 0.008, { c: '#00000030', h: 0.5 }); p.rect(0.5, 0, 0.008, 1, { c: '#00000030', h: 0.5 }); }
  { const p = P_(T.OF_ENTRANCE); glass(p, 0, 0, 1, 1, { modern: true }); mull(p); p.rect(0.2, 0.3, 0.6, 0.7, { c: '#1e2227', h: 0.5, r: 0.4, m: 0.7 }); glass(p, 0.23, 0.33, 0.26, 0.67, { modern: true }); glass(p, 0.51, 0.33, 0.26, 0.67, { modern: true }); p.rect(0.1, 0.22, 0.8, 0.05, { c: '#30353b', h: 0.95, r: 0.4, m: 0.6 }); }
  { const p = P_(T.OF_LOBBY); glass(p, 0, 0, 1, 1, { modern: true }); mull(p); p.rect(0, 0.9, 1, 0.1, { c: '#3a3d41', h: 0.66, r: 0.6 }); }
  { const p = P_(T.OF_LOUVER); p.rect(0, 0, 1, 1, { c: '#7d848c', h: 0.5, r: 0.5, m: 0.6 }); for (let i = 0; i < 16; i++) p.rect(0, i / 16, 1, 0.03, { c: '#3d4349', h: 0.3, r: 0.5, m: 0.6 }); }
  { const p = P_(T.OF_BLINDS); glass(p, 0, 0, 1, 1, { modern: true, blinds: 0.55 }); mull(p); }
  // --- row 3: apartment
  const blind = (p: Pen, x: number, y: number, w: number) => p.rect(x - 0.01, y - 0.06, w + 0.02, 0.06, { c: '#c9c6bd', h: 0.8, r: 0.6 });
  { const p = P_(T.AP_WIN); frameWin(p, 0.3, 0.26, 0.4, 0.46, { cols: 2, rows: 1, curtain: '#f1ede2' }); blind(p, 0.3, 0.26, 0.4); }
  { const p = P_(T.AP_BALC); frameWin(p, 0.16, 0.16, 0.68, 0.74, { cols: 3, rows: 1, sill: false, curtain: '#f1ede2' }); blind(p, 0.16, 0.16, 0.68); p.rect(0.04, 0.9, 0.92, 0.06, { c: '#b5b1a7', h: 1, r: 0.85 }); p.rect(0.05, 0.56, 0.9, 0.34, { c: '#8fa0ad', h: 0.97, em: 0.2, r: 0.12, m: 0.5 }); p.rect(0.05, 0.55, 0.9, 0.02, { c: '#34383c', h: 1, r: 0.4, m: 0.7 }); p.rect(0.04, 0.96, 0.92, 0.04, { c: '#00000055', h: 0.5 }); }
  { const p = P_(T.AP_PAIR); for (const x of [0.1, 0.56]) { frameWin(p, x, 0.26, 0.34, 0.46, { cols: 2, rows: 1, curtain: '#ebe6d9' }); blind(p, x, 0.26, 0.34); } }
  { const p = P_(T.AP_BLANK); p.rect(0, 0.992, 1, 0.008, { c: '#00000018', tint: 1, h: 0.56 }); }
  { const p = P_(T.AP_DOOR); p.rect(0, 0.88, 1, 0.12, { c: '#77736b', tint: 0.3, h: 0.7, r: 0.9 }); door(p, 0.32, 0.36, 0.3, '#2c3238', { glass: true, frame: '#d5d1c7' }); p.rect(0.2, 0.2, 0.6, 0.045, { c: '#9a968c', h: 1, r: 0.8 }); }
  { const p = P_(T.AP_GARAGE); p.rect(0, 0.88, 1, 0.12, { c: '#77736b', tint: 0.3, h: 0.7, r: 0.9 }); p.rect(0.12, 0.3, 0.76, 0.7, { c: '#8e939a', h: 0.45, r: 0.6, m: 0.3 }); for (let i = 0; i < 7; i++) p.rect(0.12, 0.3 + i * 0.1, 0.76, 0.008, { c: '#5b6068', h: 0.34 }); }
  { const p = P_(T.AP_STAIR); frameWin(p, 0.4, 0.08, 0.2, 0.84, { cols: 1, rows: 4, sill: false, frame: '#3a3e44' }); }
  { const p = P_(T.AP_AWN); frameWin(p, 0.3, 0.26, 0.4, 0.46, { cols: 2, rows: 1, curtain: '#f1ede2' }); p.rect(0.26, 0.2, 0.48, 0.2, { c: '#e9e9e9', acc: 1, h: 0.96, r: 0.8 }); for (let i = 0; i < 6; i++) if (i % 2) p.rect(0.26 + (0.48 * i) / 6, 0.2, 0.08, 0.2, { c: '#fafafa', acc: 0.2, h: 0.96, r: 0.8 }); p.rect(0.26, 0.4, 0.48, 0.02, { c: '#00000045', h: 0.5 }); }
  // --- row 4: villa / chalet
  { const p = P_(T.VI_WIN); frameWin(p, 0.33, 0.24, 0.34, 0.5, { curtain: '#f1ede2' }); shutters(p, 0.33, 0.24, 0.34, 0.5); }
  { const p = P_(T.VI_FRENCH); frameWin(p, 0.24, 0.14, 0.52, 0.86, { cols: 2, rows: 3, sill: false, curtain: '#f1ede2' }); }
  { const p = P_(T.CH_TIMBER); planksH(p, 0, 0, 1, 1, rng); }
  { const p = P_(T.CH_WIN); planksH(p, 0, 0, 1, 1, rng); frameWin(p, 0.32, 0.26, 0.36, 0.44, { curtain: '#efe6d0', frame: '#e6dcc6' }); shutters(p, 0.32, 0.26, 0.36, 0.44); flowerBox(p, 0.32, 0.72, 0.36, rng); }
  { const p = P_(T.CH_BALC); planksH(p, 0, 0, 1, 0.5, rng, 6); frameWin(p, 0.3, 0.08, 0.4, 0.5, { curtain: '#efe6d0', frame: '#e6dcc6', sill: false }); p.rect(0, 0.56, 1, 0.44, { c: '#00000060', h: 0.3 }); for (let i = 0; i < 12; i++) p.rect(i / 12 + 0.012, 0.58, 1 / 12 - 0.024, 0.36, { c: '#c9c9c9', tint: 1, h: 0.96, r: 0.86 }); p.rect(0, 0.55, 1, 0.045, { c: '#d9d9d9', tint: 1, h: 1, r: 0.86 }); p.rect(0, 0.94, 1, 0.06, { c: '#bdbdbd', tint: 1, h: 1, r: 0.86 }); flowerBox(p, 0.03, 0.52, 0.94, rng); }
  { const p = P_(T.CH_STONE); rubble(p, rng); }
  { const p = P_(T.CH_STONE_DOOR); rubble(p, rng); door(p, 0.34, 0.32, 0.3, '#4a2f1c', { frame: '#6b5a48' }); }
  { const p = P_(T.CH_BARN); planksV(p, 0, 0, 1, 1, rng); p.rect(0.2, 0.3, 0.6, 0.7, { c: '#00000035', h: 0.4 }); p.rect(0.495, 0.3, 0.01, 0.7, { c: '#00000080', h: 0.3 }); p.rect(0.18, 0.28, 0.64, 0.03, { c: '#00000050', h: 0.7 }); }
  // --- row 5: industrial
  const corrug = (p: Pen) => { p.rect(0, 0, 1, 1, { c: '#ffffff', tint: 1, h: 0.6, r: 0.45, m: 0.55 }); for (let i = 0; i < 32; i++) p.rect(i / 32, 0, 1 / 64, 1, { c: '#d9d9d9', tint: 1, h: 0.4, r: 0.45, m: 0.55 }); };
  { corrug(P_(T.IN_METAL)); }
  { const p = P_(T.IN_STRIP); corrug(p); p.rect(0, 0.18, 1, 0.3, { c: '#30353b', h: 0.5, r: 0.5, m: 0.5 }); for (let i = 0; i < 4; i++) glass(p, i / 4 + 0.012, 0.2, 1 / 4 - 0.024, 0.26, {}); }
  { const p = P_(T.IN_ROLLER); corrug(p); p.rect(0.1, 0.16, 0.8, 0.84, { c: '#b9bdc2', h: 0.45, r: 0.5, m: 0.5 }); for (let i = 0; i < 14; i++) p.rect(0.1, 0.16 + i * 0.06, 0.8, 0.008, { c: '#6f757c', h: 0.34 }); p.rect(0.1, 0.92, 0.8, 0.08, { c: '#d7b21c', h: 0.5, r: 0.6 }); }
  const brick = (p: Pen) => { p.rect(0, 0, 1, 1, { c: '#b9b2a8', h: 0.45, r: 0.95 }); for (let r = 0; r < 20; r++) for (let c = -1; c < 8; c++) { const v = rng.next(); p.rect(c / 8 + (r % 2) / 16 + 0.004, r / 20 + 0.004, 1 / 8 - 0.008, 1 / 20 - 0.008, { c: `rgb(${150 + v * 40},${78 + v * 30},${58 + v * 22})`, h: 0.62 + v * 0.06, r: 0.92 }); } };
  { brick(P_(T.IN_BRICK)); }
  { const p = P_(T.IN_BRICK_WIN); brick(p); frameWin(p, 0.2, 0.2, 0.6, 0.56, { cols: 4, rows: 4, frame: '#2e3338', fw: 0.012 }); }
  { const p = P_(T.IN_CONCRETE); p.rect(0, 0, 1, 1, { c: '#ffffff', tint: 1, h: 0.6, r: 0.9 }); p.rect(0, 0, 0.012, 1, { c: '#00000035', h: 0.4 }); p.rect(0, 0.5, 1, 0.01, { c: '#00000028', h: 0.45 }); for (let i = 0; i < 4; i++) p.ellipse(0.25 + (i % 2) * 0.5, 0.25 + Math.floor(i / 2) * 0.5, 0.014, 0.014, { c: '#00000040', h: 0.4 }); }
  { const p = P_(T.IN_DOCK); p.rect(0, 0, 1, 1, { c: '#ffffff', tint: 1, h: 0.6, r: 0.9 }); p.rect(0.14, 0.24, 0.72, 0.5, { c: '#d9dcdf', h: 0.45, r: 0.5, m: 0.4 }); for (let i = 0; i < 8; i++) p.rect(0.14, 0.24 + i * 0.062, 0.72, 0.008, { c: '#8a9097', h: 0.34 }); p.rect(0.1, 0.2, 0.8, 0.04, { c: '#1c1e21', h: 0.9, r: 0.9 }); p.rect(0.1, 0.2, 0.04, 0.58, { c: '#1c1e21', h: 0.9, r: 0.9 }); p.rect(0.86, 0.2, 0.04, 0.58, { c: '#1c1e21', h: 0.9, r: 0.9 }); p.rect(0, 0.78, 1, 0.22, { c: '#6f6c66', h: 0.8, r: 0.95 }); p.rect(0.2, 0.8, 0.1, 0.08, { c: '#1c1e21', h: 0.9 }); p.rect(0.7, 0.8, 0.1, 0.08, { c: '#1c1e21', h: 0.9 }); }
  { const p = P_(T.IN_OFFICE); corrug(p); p.rect(0.08, 0.26, 0.84, 0.44, { c: '#30353b', h: 0.5, r: 0.5, m: 0.5 }); glass(p, 0.1, 0.28, 0.39, 0.4, { blinds: 0.3 }); glass(p, 0.51, 0.28, 0.39, 0.4, {}); }
  // --- row 6: sandstone landmarks
  const sand = (tile: number) => { const p = P_(tile); blocks(p, 0, 0, 1, 1, 0.5, 0.167, rng, '#9a9080', 1); return p; };
  sand(T.ST_BLANK);
  { const p = sand(T.ST_ARCH_WIN); p.rect(0.3, 0.3, 0.4, 0.62, { c: '#e7e0d0', tint: 0.5, h: 0.8 }); p.ellipse(0.5, 0.3, 0.2, 0.2, { c: '#e7e0d0', tint: 0.5, h: 0.8 }, true); frameWin(p, 0.35, 0.3, 0.3, 0.56, { cols: 2, rows: 4, arch: true, frame: '#4a463e', fw: 0.012 }); }
  { const p = sand(T.ST_PORTAL); p.rect(0.12, 0.22, 0.76, 0.78, { c: '#e7e0d0', tint: 0.5, h: 0.85 }); p.ellipse(0.5, 0.24, 0.38, 0.22, { c: '#e7e0d0', tint: 0.5, h: 0.85 }, true); door(p, 0.2, 0.6, 0.26, '#3a2a1e', { arch: true, frame: '#bfb7a6' }); }
  { const p = sand(T.ST_PILASTER); p.rect(0.04, 0.0, 0.12, 1, { c: '#f0ebe0', tint: 0.6, h: 0.9 }); p.rect(0.84, 0.0, 0.12, 1, { c: '#f0ebe0', tint: 0.6, h: 0.9 }); p.rect(0.26, 0.14, 0.48, 0.74, { c: '#e7e0d0', tint: 0.5, h: 0.78 }); frameWin(p, 0.31, 0.2, 0.38, 0.6, { cols: 2, rows: 3, lintel: true }); }
  { const p = sand(T.ST_CLOCK); p.ellipse(0.5, 0.5, 0.4, 0.4, { c: '#1c2a3a', h: 0.8, r: 0.5 }); p.ellipse(0.5, 0.5, 0.36, 0.36, { c: '#f4efe2', h: 0.75, em: 0.8, r: 0.6 }); for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; p.rect(0.5 + Math.sin(a) * 0.3 - 0.012, 0.5 - Math.cos(a) * 0.3 - 0.025, 0.024, 0.05, { c: '#b8962e', h: 0.8, r: 0.4, m: 0.8 }); } p.rect(0.49, 0.26, 0.02, 0.26, { c: '#161616', h: 0.86 }); p.rect(0.5, 0.49, 0.17, 0.02, { c: '#161616', h: 0.86 }); }
  { const p = sand(T.ST_ROSE); p.ellipse(0.5, 0.5, 0.3, 0.3, { c: '#e7e0d0', tint: 0.5, h: 0.84 }); p.ellipse(0.5, 0.5, 0.25, 0.25, { c: GLASS_T, h: 0.3, em: 1, r: 0.1, m: 0.6 }); for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; p.rect(0.5 + Math.sin(a) * 0.12 - 0.008, 0.5 - Math.cos(a) * 0.12 - 0.008, 0.016, 0.016, { c: '#e7e0d0', tint: 0.5, h: 0.8 }); } }
  { const p = sand(T.ST_BAND); cornice(p, 0, 0.09, '#ebe5d6'); cornice(p, 0.09, 0.03, '#cfc8b8'); }
  { const p = sand(T.ST_BELFRY); p.rect(0.26, 0.22, 0.48, 0.66, { c: '#17140f', h: 0.15, r: 1 }); p.ellipse(0.5, 0.22, 0.24, 0.18, { c: '#17140f', h: 0.15, r: 1 }, true); for (let i = 0; i < 7; i++) p.rect(0.26, 0.26 + i * 0.09, 0.48, 0.035, { c: '#5b5245', h: 0.5, r: 0.9 }); p.rect(0.492, 0.1, 0.016, 0.8, { c: '#cfc8b8', tint: 0.5, h: 0.8 }); }
  // --- row 7: misc
  { const p = P_(T.TW_GLASS_A); p.rect(0, 0, 1, 1, { c: '#3d5a58', h: 0.3, em: 1, r: 0.05, m: 0.9 }); p.rect(0, 0.72, 1, 0.28, { c: '#2c4442', h: 0.3, em: 0.3, r: 0.07, m: 0.9 }); p.rect(0, 0, 0.012, 1, { c: '#1d2a29', h: 0.5, r: 0.3, m: 0.8 }); p.rect(0.5, 0, 0.008, 1, { c: '#1d2a29', h: 0.45, r: 0.3, m: 0.8 }); p.rect(0, 0, 1, 0.012, { c: '#1d2a29', h: 0.5, r: 0.3, m: 0.8 }); }
  { const p = P_(T.TW_GLASS_B); p.rect(0, 0, 1, 1, { c: '#4a5f74', h: 0.3, em: 1, r: 0.05, m: 0.9 }); p.rect(0, 0.76, 1, 0.24, { c: '#2a3540', h: 0.34, em: 0.2, r: 0.1, m: 0.85 }); p.rect(0, 0, 0.014, 1, { c: '#c9ced3', h: 0.62, r: 0.3, m: 0.9 }); p.rect(0.333, 0, 0.008, 1, { c: '#27313b', h: 0.4, r: 0.3, m: 0.8 }); p.rect(0.666, 0, 0.008, 1, { c: '#27313b', h: 0.4, r: 0.3, m: 0.8 }); }
  { const p = P_(T.KIOSK); shop(p, { frame: '#8a1620', sign: true, base: '#5d5a55' }); }
  { const p = P_(T.HOSP_STRIP); p.rect(0, 0, 1, 1, { c: '#ffffff', tint: 1, h: 0.62, r: 0.75 }); p.rect(0, 0.24, 1, 0.5, { c: '#d8d8d4', h: 0.52, r: 0.5 }); glass(p, 0.02, 0.27, 0.46, 0.44, { blinds: 0.25 }); glass(p, 0.52, 0.27, 0.46, 0.44, {}); p.rect(0, 0.985, 1, 0.015, { c: '#00000030', h: 0.5 }); }
  { const p = P_(T.RAW_CONCRETE); p.rect(0, 0, 1, 1, { c: '#b9b6ae', h: 0.6, r: 0.92 }); for (let i = 0; i < 5; i++) p.rect(0, i / 5, 1, 0.006, { c: '#8f8c85', h: 0.45 }); }
  { const p = P_(T.SHOWROOM); glass(p, 0, 0, 1, 1, { modern: true }); p.rect(0, 0, 1, 0.1, { c: '#e9e9e9', acc: 1, h: 0.7, r: 0.5 }); p.rect(0, 0.94, 1, 0.06, { c: '#2a2d31', h: 0.66, r: 0.6 }); p.rect(0.98, 0, 0.02, 1, { c: '#2a2d31', h: 0.6, r: 0.4, m: 0.6 }); }
  { const p = P_(T.CH_STONE_WIN); rubble(p, rng); p.rect(0.34, 0.28, 0.32, 0.4, { c: '#d8cfbc', h: 0.75, r: 0.9 }); frameWin(p, 0.37, 0.31, 0.26, 0.34, { frame: '#e6dcc6', curtain: '#efe6d0' }); }
  { P_(T.WHITE); }

  // ---------------------------------------------------------------- compose textures
  const cd = C.getImageData(0, 0, size, size).data, md = M.getImageData(0, 0, size, size).data;
  const hd = H.getImageData(0, 0, size, size).data, pd = P.getImageData(0, 0, size, size).data;
  const grain = noiseField(size, size / 2, 9001), stain = fbmField(size, 16, 4, 9002, 0.55);
  const alb = new Uint8Array(size * size * 4), props = new Uint8Array(size * size * 4), hf = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const k = i * 4;
    const tint = md[k] / 255;
    // plaster grain and staining only on wall areas
    const f = 1 - tint * (0.1 * (grain[i] - 0.5) + 0.16 * (stain[i] - 0.5));
    alb[k] = Math.min(255, cd[k] * f);
    alb[k + 1] = Math.min(255, cd[k + 1] * f);
    alb[k + 2] = Math.min(255, cd[k + 2] * f);
    alb[k + 3] = md[k];
    props[k] = pd[k];
    props[k + 1] = pd[k + 1];
    props[k + 2] = pd[k + 2];
    props[k + 3] = md[k + 1];
    hf[i] = hd[k] / 255 + tint * (grain[i] - 0.5) * 0.05;
  }
  // normal map (non wrapping: clamp sampling)
  const nrm = new Uint8Array(size * size * 4);
  const strength = 2.6 * (size / 2048);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(size - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(size - 1, y + 1);
      const dx = (hf[y * size + xp] - hf[y * size + xm]) * strength * 4, dy = (hf[yp * size + x] - hf[ym * size + x]) * strength * 4;
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const k = (y * size + x) * 4;
      nrm[k] = (-dx * il * 0.5 + 0.5) * 255;
      nrm[k + 1] = (-dy * il * 0.5 + 0.5) * 255;
      nrm[k + 2] = (il * 0.5 + 0.5) * 255;
      nrm[k + 3] = 255;
    }
  const albedo = dataTexture(alb, size, { srgb: true, repeat: false, aniso: anisotropy });
  const propsTex = dataTexture(props, size, { repeat: false, aniso: anisotropy });
  const normalTex = dataTexture(nrm, size, { repeat: false, aniso: anisotropy });
  void cC; void cM; void cH; void cP;

  const material = new THREE.MeshStandardMaterial({ map: albedo, normalMap: normalTex, roughnessMap: propsTex, metalnessMap: propsTex, roughness: 1, metalness: 1, vertexColors: true, normalScale: new THREE.Vector2(1, 1) });
  patchMaterial(material, 'facade', (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.uniforms.uLit = uLit;
    sh.uniforms.uSnow = U.uSnow;
    sh.vertexShader = replaceOnce(sh.vertexShader, '#include <common>', '#include <common>\nattribute vec4 aAccent;\nvarying vec4 vAccent;');
    sh.vertexShader = replaceOnce(sh.vertexShader, '#include <begin_vertex>', '#include <begin_vertex>\nvAccent = aAccent;');
    sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <common>', '#include <common>\nuniform float uNight; uniform float uLit; uniform float uSnow;\nvarying vec4 vAccent;\nvec4 gProps;');
    sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <color_fragment>', `
gProps = texture2D(roughnessMap, vMapUv);
diffuseColor.rgb *= mix(vec3(1.0), vColor.rgb, sampledDiffuseColor.a);
diffuseColor.rgb *= mix(vec3(1.0), vAccent.rgb, gProps.a);
diffuseColor.a = 1.0;`);
    sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float rnd = vColor.a;
  float on = step(rnd, uLit) * uNight;
  vec3 warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.9, 0.93, 1.0), step(0.72, fract(rnd * 7.31)));
  totalEmissiveRadiance += gProps.r * on * warm * (1.1 + 1.6 * fract(rnd * 13.7));
}`);
  });
  const inset = 1.5 / size;
  return {
    material, albedo, size,
    rect(tile, out) {
      const c = tile % ATLAS_TILES, r = Math.floor(tile / ATLAS_TILES);
      out[0] = c / ATLAS_TILES + inset;
      out[1] = r / ATLAS_TILES + inset;
      out[2] = (c + 1) / ATLAS_TILES - inset;
      out[3] = (r + 1) / ATLAS_TILES - inset;
      return out;
    },
  };
}
/** Fraction of windows that are lit (driven by the clock). */
export const uLit = { value: 0.5 };
