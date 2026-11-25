// Procedural texture synthesis (no external image assets). Everything is tileable.
import * as THREE from 'three';
import { Rng } from '../../shared/math';

export type Field = Float32Array;

/** Tileable smooth value noise field in [0,1]. */
export function noiseField(size: number, cells: number, seed: number): Field {
  const rng = new Rng(seed);
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  const out = new Float32Array(size * size);
  const s = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * s, y0 = Math.floor(fy), ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x * s, x0 = Math.floor(fx), tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % cells, c1 = (x0 + 1) % cells;
      const a = g[r0 + c0], b = g[r0 + c1], c = g[r1 + c0], d = g[r1 + c1];
      out[y * size + x] = a + (b - a) * sx + (c + (d - c) * sx - (a + (b - a) * sx)) * sy;
    }
  }
  return out;
}
export function fbmField(size: number, baseCells: number, octaves: number, seed: number, gain = 0.5): Field {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, cells = baseCells;
  for (let o = 0; o < octaves && cells <= size; o++) {
    const n = noiseField(size, cells, seed + o * 17);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp;
    amp *= gain;
    cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
/** Tileable cellular (Worley F1) distance field, normalised 0..1. Also returns cell ids. */
export function cellField(size: number, cells: number, seed: number, jitter = 0.9): { d: Field; id: Field; edge: Field } {
  const rng = new Rng(seed);
  const px = new Float32Array(cells * cells), py = new Float32Array(cells * cells), pid = new Float32Array(cells * cells);
  for (let i = 0; i < px.length; i++) {
    px[i] = 0.5 + (rng.next() - 0.5) * jitter;
    py[i] = 0.5 + (rng.next() - 0.5) * jitter;
    pid[i] = rng.next();
  }
  const d = new Float32Array(size * size), id = new Float32Array(size * size), edge = new Float32Array(size * size);
  const s = cells / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const fx = x * s, fy = y * s;
      const cx = Math.floor(fx), cy = Math.floor(fy);
      let b1 = 9, b2 = 9, bi = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox, gy = cy + oy;
          const k = (((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells);
          const dx = gx + px[k] - fx, dy = gy + py[k] - fy;
          const dd = Math.sqrt(dx * dx + dy * dy);
          if (dd < b1) { b2 = b1; b1 = dd; bi = k; }
          else if (dd < b2) b2 = dd;
        }
      d[y * size + x] = Math.min(1, b1);
      id[y * size + x] = pid[bi];
      edge[y * size + x] = Math.min(1, b2 - b1);
    }
  return { d, id, edge };
}

export interface TexOpts { srgb?: boolean; repeat?: boolean; aniso?: number; mip?: boolean }
export function dataTexture(rgba: Uint8Array, size: number, o: TexOpts = {}): THREE.DataTexture {
  const t = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat);
  t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (o.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = o.mip !== false;
  t.minFilter = o.mip !== false ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = o.aniso ?? 8;
  t.needsUpdate = true;
  return t;
}

/** Height field → tangent-space normal map (RGB) with height in alpha. */
export function normalFromHeight(h: Field, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size, yp = ((y + 1) % size) * size, yc = y * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const dx = (h[yc + xp] - h[yc + xm]) * strength, dy = (h[yp + x] - h[ym + x]) * strength;
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (yc + x) * 4;
      out[i] = (-dx * il * 0.5 + 0.5) * 255;
      out[i + 1] = (-dy * il * 0.5 + 0.5) * 255;
      out[i + 2] = (il * 0.5 + 0.5) * 255;
      out[i + 3] = Math.max(0, Math.min(255, h[yc + x] * 255));
    }
  }
  return out;
}

function colorize(size: number, fn: (i: number, x: number, y: number, out: number[]) => void): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const c = [0, 0, 0, 1];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      c[3] = 1;
      fn(i, x, y, c);
      out[i * 4] = Math.max(0, Math.min(255, c[0] * 255));
      out[i * 4 + 1] = Math.max(0, Math.min(255, c[1] * 255));
      out[i * 4 + 2] = Math.max(0, Math.min(255, c[2] * 255));
      out[i * 4 + 3] = Math.max(0, Math.min(255, c[3] * 255));
    }
  return out;
}

export interface DetailTex { map: THREE.Texture; normal: THREE.Texture }

/** Neutral-grey detail albedo (average ≈ 0.5) + normal map for the terrain layers. */
export function makeTerrainDetail(size = 512): { grass: DetailTex; rock: DetailTex; paved: DetailTex; dirt: DetailTex; macro: THREE.Texture } {
  // grass: fine blades + clumps
  const g1 = fbmField(size, 8, 5, 101), g2 = noiseField(size, 128, 102), g3 = noiseField(size, 256, 103);
  const gh = new Float32Array(size * size);
  for (let i = 0; i < gh.length; i++) gh[i] = g1[i] * 0.55 + g2[i] * 0.25 + g3[i] * 0.2;
  const grass: DetailTex = {
    map: dataTexture(colorize(size, (i, _x, _y, c) => {
      const v = 0.32 + gh[i] * 0.36;
      c[0] = v * (0.94 + g2[i] * 0.2);
      c[1] = v * 1.04;
      c[2] = v * (0.86 + g3[i] * 0.12);
    }), size, { srgb: true }),
    normal: dataTexture(normalFromHeight(gh, size, 3.2), size),
  };
  // rock: strata + cracks
  const r1 = fbmField(size, 4, 6, 201, 0.55), cr = cellField(size, 9, 202);
  const rh = new Float32Array(size * size);
  for (let i = 0; i < rh.length; i++) {
    const crack = Math.min(1, cr.edge[i] * 9);
    rh[i] = r1[i] * 0.75 + cr.id[i] * 0.18 + crack * 0.07;
    if (crack < 0.5) rh[i] -= (0.5 - crack) * 0.35;
  }
  const rock: DetailTex = {
    map: dataTexture(colorize(size, (i, _x, _y, c) => {
      const v = 0.3 + rh[i] * 0.42;
      c[0] = v * 1.02; c[1] = v; c[2] = v * 0.97;
    }), size, { srgb: true }),
    normal: dataTexture(normalFromHeight(rh, size, 5.5), size),
  };
  // paved: cobble setts (irregular cells)
  const cb = cellField(size, 22, 301, 0.55), pn = fbmField(size, 16, 4, 302);
  const ph = new Float32Array(size * size);
  for (let i = 0; i < ph.length; i++) {
    const joint = Math.min(1, cb.edge[i] * 7);
    ph[i] = joint * (0.72 + cb.id[i] * 0.2) + pn[i] * 0.08;
  }
  const paved: DetailTex = {
    map: dataTexture(colorize(size, (i, _x, _y, c) => {
      const joint = Math.min(1, cb.edge[i] * 7);
      const v = (0.36 + cb.id[i] * 0.2 + pn[i] * 0.1) * (0.55 + 0.45 * joint);
      c[0] = v * 1.02; c[1] = v; c[2] = v * 0.96;
    }), size, { srgb: true }),
    normal: dataTexture(normalFromHeight(ph, size, 4.5), size),
  };
  // dirt / forest floor / field
  const d1 = fbmField(size, 6, 6, 401, 0.6), d2 = noiseField(size, 200, 402);
  const dh = new Float32Array(size * size);
  for (let i = 0; i < dh.length; i++) dh[i] = d1[i] * 0.7 + d2[i] * 0.3;
  const dirt: DetailTex = {
    map: dataTexture(colorize(size, (i, _x, _y, c) => {
      const v = 0.34 + dh[i] * 0.36;
      c[0] = v * 1.05; c[1] = v; c[2] = v * 0.92;
    }), size, { srgb: true }),
    normal: dataTexture(normalFromHeight(dh, size, 3.6), size),
  };
  const m = fbmField(256, 4, 5, 501, 0.55);
  const macro = dataTexture(colorize(256, (i, _x, _y, c) => { c[0] = c[1] = c[2] = m[i]; }), 256);
  return { grass, rock, paved, dirt, macro };
}

/** Asphalt with aggregate, patches and faint cracks (albedo + normal + roughness in alpha of normal). */
export function makeAsphalt(size = 512): DetailTex {
  const a = noiseField(size, 256, 601), b = fbmField(size, 6, 5, 602, 0.6), cr = cellField(size, 5, 603, 1.0);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    const crack = Math.min(1, cr.edge[i] * 26);
    h[i] = a[i] * 0.35 + b[i] * 0.5 + (crack < 0.35 && b[i] > 0.6 ? -0.2 : 0) + 0.15;
  }
  return {
    map: dataTexture(colorize(size, (i, _x, _y, c) => {
      const crack = Math.min(1, cr.edge[i] * 26);
      let v = 0.105 + a[i] * 0.05 + b[i] * 0.075;
      if (crack < 0.35 && b[i] > 0.6) v *= 0.72;
      if (cr.id[i] > 0.86) v *= 0.9; // repair patches
      c[0] = v; c[1] = v * 1.01; c[2] = v * 1.04;
    }), size, { srgb: true }),
    normal: dataTexture(normalFromHeight(h, size, 2.4), size),
  };
}

/** Interlocking roof tiles (pitched roofs) – neutral so vertex colours tint it. */
export function makeRoofTiles(size = 256): DetailTex {
  const n = fbmField(size, 8, 4, 701);
  const h = new Float32Array(size * size);
  const rows = 8, cols = 8;
  const alb = colorize(size, (i, x, y, c) => {
    const v = y / size * rows;
    const row = Math.floor(v), fv = v - row;
    const u = x / size * cols + (row % 2) * 0.5;
    const fu = u - Math.floor(u);
    const id = (Math.sin((Math.floor(u) % cols) * 12.9898 + row * 78.233) * 43758.5453) % 1;
    // tile profile: curved across, stepped along
    const across = Math.sin(fu * Math.PI);
    const step = 1 - fv;
    h[i] = across * 0.45 + step * 0.55;
    const shade = 0.68 + 0.26 * across * (0.55 + 0.45 * step) + Math.abs(id) * 0.14 + n[i] * 0.12 - (fv > 0.93 ? 0.26 : 0);
    c[0] = shade; c[1] = shade; c[2] = shade;
  });
  return { map: dataTexture(alb, size, { srgb: true }), normal: dataTexture(normalFromHeight(h, size, 3.0), size) };
}

/** Gravel / bitumen for flat roofs. */
export function makeFlatRoof(size = 256): DetailTex {
  const a = noiseField(size, 128, 801), b = fbmField(size, 4, 4, 802);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.6 + b[i] * 0.4;
  return {
    map: dataTexture(colorize(size, (i, _x, _y, c) => { const v = 0.7 + a[i] * 0.2 + b[i] * 0.16; c[0] = c[1] = c[2] = v; }), size, { srgb: true }),
    normal: dataTexture(normalFromHeight(h, size, 2.0), size),
  };
}

/** Two-channel water ripple normals. */
export function makeWaterNormals(size = 256): THREE.Texture {
  const a = fbmField(size, 6, 5, 901, 0.6), b = fbmField(size, 10, 4, 902, 0.55);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.65 + b[i] * 0.35;
  return dataTexture(normalFromHeight(h, size, 7), size);
}

/** RGBA noise for clouds / misc shader lookups. */
export function makeNoiseRGBA(size = 256): THREE.Texture {
  const r = fbmField(size, 4, 6, 1001, 0.55), g = fbmField(size, 8, 5, 1002, 0.5), b = noiseField(size, 64, 1003), a = noiseField(size, size, 1004);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = r[i] * 255; out[i * 4 + 1] = g[i] * 255; out[i * 4 + 2] = b[i] * 255; out[i * 4 + 3] = a[i] * 255;
  }
  return dataTexture(out, size);
}

export function canvasTexture(canvas: HTMLCanvasElement, o: TexOpts = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (o.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = o.aniso ?? 8;
  t.generateMipmaps = o.mip !== false;
  t.minFilter = o.mip !== false ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  return t;
}
export function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}
