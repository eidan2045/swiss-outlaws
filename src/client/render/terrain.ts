// Chunked terrain with distance LOD, skirts, vertex-colour land cover and detail-texture splatting.
import * as THREE from 'three';
import { hash2, noise2, clamp01 } from '../../shared/math';
import { N, RES, Surf, World } from '../../shared/world/world';
import { WORLD_HALF, Zone } from '../../shared/world/layout';
import { Quality, U, patchMaterial, replaceOnce } from './globals';
import { makeTerrainDetail } from './textures';

export const CHUNK = 192; // metres
export const CHUNKS = (WORLD_HALF * 2) / CHUNK; // 16
const CELLS = CHUNK / RES; // 96
const LODS = 4;

interface Chunk {
  cx: number;
  cz: number;
  center: THREE.Vector3;
  lods: (THREE.Mesh | null)[];
  cur: number;
  minY: number;
  maxY: number;
}

const PALETTE: Record<number, [number, number, number]> = {
  [Surf.Grass]: [0.3, 0.4, 0.13],
  [Surf.Asphalt]: [0.1, 0.1, 0.108],
  [Surf.Cobble]: [0.34, 0.31, 0.28],
  [Surf.Paved]: [0.4, 0.39, 0.37],
  [Surf.Field]: [0.45, 0.42, 0.18],
  [Surf.Rock]: [0.4, 0.39, 0.37],
  [Surf.Snow]: [0.9, 0.92, 0.96],
  [Surf.Sand]: [0.66, 0.59, 0.42],
  [Surf.Forest]: [0.17, 0.2, 0.09],
  [Surf.Gravel]: [0.33, 0.31, 0.29],
};
// splat weights: grass, rock, paved, dirt
const SPLAT: Record<number, [number, number, number, number]> = {
  [Surf.Grass]: [1, 0, 0, 0],
  [Surf.Asphalt]: [0, 0.55, 0, 0.45],
  [Surf.Cobble]: [0, 0, 1, 0],
  [Surf.Paved]: [0, 0.15, 0.85, 0],
  [Surf.Field]: [0.35, 0, 0, 0.65],
  [Surf.Rock]: [0, 1, 0, 0],
  [Surf.Snow]: [0, 0.35, 0, 0.1],
  [Surf.Sand]: [0, 0.1, 0, 0.9],
  [Surf.Forest]: [0.3, 0, 0, 0.7],
  [Surf.Gravel]: [0, 0.75, 0, 0.25],
};

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private chunks: Chunk[] = [];
  private queue: { c: Chunk; lod: number }[] = [];

  constructor(private world: World, private quality: Quality) {
    const det = makeTerrainDetail(512);
    for (const t of [det.grass, det.rock, det.paved, det.dirt]) {
      t.map.anisotropy = quality.anisotropy;
      t.normal.anisotropy = quality.anisotropy;
    }
    // tunnels: up to four straight segments whose volume is cut out of the terrain surface
    const tunA: THREE.Vector4[] = [], tunB: THREE.Vector4[] = [];
    for (const e of world.roads.edges) {
      let i0 = -1, i1 = -1;
      for (let i = 0; i < e.n; i++) if (e.flag[i] === 2) { if (i0 < 0) i0 = i; i1 = i; }
      if (i0 < 0 || i1 - i0 < 2) continue;
      const parts = Math.min(4 - tunA.length, i1 - i0 > 12 ? 4 : 2);
      for (let k = 0; k < parts; k++) {
        const a = Math.round(i0 + ((i1 - i0) * k) / parts), b = Math.round(i0 + ((i1 - i0) * (k + 1)) / parts);
        tunA.push(new THREE.Vector4(e.px[a], e.pz[a], e.px[b], e.pz[b]));
        tunB.push(new THREE.Vector4(e.py[a], e.py[b], e.width / 2 + 1.5, 0));
      }
    }
    const tunN = tunA.length;
    while (tunA.length < 4) { tunA.push(new THREE.Vector4()); tunB.push(new THREE.Vector4()); }
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    patchMaterial(this.material, 'terrain', (sh) => {
      Object.assign(sh.uniforms, {
        tGrass: { value: det.grass.map }, tRock: { value: det.rock.map }, tPaved: { value: det.paved.map }, tDirt: { value: det.dirt.map },
        nGrass: { value: det.grass.normal }, nRock: { value: det.rock.normal }, nPaved: { value: det.paved.normal }, nDirt: { value: det.dirt.normal },
        tMacro: { value: det.macro }, uWet: U.uWet, uSnow: U.uSnow, uCamPos: U.uCamPos,
        uTunA: { value: tunA }, uTunB: { value: tunB }, uTunN: { value: tunN },
      });
      sh.vertexShader = replaceOnce(sh.vertexShader, '#include <common>', `#include <common>
attribute vec4 aSplat;
varying vec4 vSplat;
varying vec3 vWPos;
varying vec3 vWNormal;`);
      sh.vertexShader = replaceOnce(sh.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>
vSplat = aSplat;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * normal);`);
      sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <common>', `#include <common>
uniform sampler2D tGrass, tRock, tPaved, tDirt, nGrass, nRock, nPaved, nDirt, tMacro;
uniform float uWet, uSnow;
uniform vec3 uCamPos;
uniform vec4 uTunA[4]; uniform vec4 uTunB[4]; uniform int uTunN;
varying vec4 vSplat;
varying vec3 vWPos;
varying vec3 vWNormal;
vec3 gDetN;
float gPuddle;`);
      sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <color_fragment>', `#include <color_fragment>
for (int i = 0; i < 4; i++) {
  if (i >= uTunN) break;
  vec2 ta = uTunA[i].xy, tab = uTunA[i].zw - uTunA[i].xy;
  float tt = dot(vWPos.xz - ta, tab) / dot(tab, tab);
  if (tt > -0.02 && tt < 1.02) {
    float tc = clamp(tt, 0.0, 1.0);
    if (distance(vWPos.xz, ta + tab * tc) < uTunB[i].z && vWPos.y < mix(uTunB[i].x, uTunB[i].y, tc) + 6.4) discard;
  }
}
{
  float dist = distance(vWPos, uCamPos);
  float near = 1.0 - smoothstep(60.0, 260.0, dist);
  float mid = 1.0 - smoothstep(400.0, 1400.0, dist);
  vec4 sw = vSplat / max(0.001, vSplat.x + vSplat.y + vSplat.z + vSplat.w);
  vec2 uv = vWPos.xz;
  // steep faces: project rock sideways to avoid stretching
  vec3 an = abs(vWNormal);
  vec2 uvRock = an.y > 0.72 ? uv : (an.x > an.z ? vWPos.zy : vWPos.xy);
  vec3 dG = texture2D(tGrass, uv * 0.31).rgb;
  vec3 dR = texture2D(tRock, uvRock * 0.11).rgb;
  vec3 dP = texture2D(tPaved, uv * 0.62).rgb;
  vec3 dD = texture2D(tDirt, uv * 0.27).rgb;
  vec3 det = dG * sw.x + dR * sw.y + dP * sw.z + dD * sw.w;
  // second, larger octave breaks up tiling in the mid distance
  vec3 det2 = texture2D(tGrass, uv * 0.047).rgb * sw.x + texture2D(tRock, uvRock * 0.023).rgb * sw.y + texture2D(tPaved, uv * 0.42).rgb * sw.z + texture2D(tDirt, uv * 0.041).rgb * sw.w;
  vec3 d = mix(vec3(0.5), det, near) * 2.0;
  d *= mix(vec3(1.0), det2 * 2.0, mid * 0.6);
  float macro = texture2D(tMacro, uv * 0.0021).r * 0.6 + texture2D(tMacro, uv * 0.011 + 0.3).r * 0.4;
  diffuseColor.rgb *= d * (0.78 + 0.44 * macro);
  vec3 nG = texture2D(nGrass, uv * 0.31).xyz, nR = texture2D(nRock, uvRock * 0.11).xyz, nP = texture2D(nPaved, uv * 0.62).xyz, nD = texture2D(nDirt, uv * 0.27).xyz;
  vec3 nm = nG * sw.x + nR * sw.y + nP * sw.z + nD * sw.w;
  gDetN = (nm * 2.0 - 1.0) * near;
  // snow settles on flat ground, rain darkens and forms puddles on hard surfaces
  float flat_ = smoothstep(0.55, 0.9, vWNormal.y);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.94), uSnow * flat_ * (0.75 + 0.25 * macro));
  float hard = sw.z + sw.y * 0.6;
  gPuddle = uWet * smoothstep(0.42, 0.62, macro + hard * 0.25) * flat_ * (1.0 - uSnow);
  diffuseColor.rgb *= 1.0 - uWet * 0.28 * (1.0 - uSnow);
}`);
      sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.07, gPuddle * 0.92);
roughnessFactor = mix(roughnessFactor, 0.6, uWet * 0.6);`);
      sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 nW = normalize(vWNormal);
  nW.xz += gDetN.xy * 0.55 * (1.0 - gPuddle);
  normal = normalize((viewMatrix * vec4(normalize(nW), 0.0)).xyz);
}`);
    });

    for (let cz = 0; cz < CHUNKS; cz++)
      for (let cx = 0; cx < CHUNKS; cx++) {
        const x0 = cx * CELLS, z0 = cz * CELLS;
        let minY = 1e9, maxY = -1e9;
        for (let iz = 0; iz <= CELLS; iz += 8)
          for (let ix = 0; ix <= CELLS; ix += 8) {
            const h = world.heightVis[(z0 + iz) * N + x0 + ix];
            if (h < minY) minY = h;
            if (h > maxY) maxY = h;
          }
        const c: Chunk = { cx, cz, center: new THREE.Vector3((cx + 0.5) * CHUNK - WORLD_HALF, (minY + maxY) / 2, (cz + 0.5) * CHUNK - WORLD_HALF), lods: [null, null, null, null], cur: -1, minY, maxY };
        this.chunks.push(c);
        // lowest LOD is always available so the whole world is visible immediately
        c.lods[LODS - 1] = this.build(c, LODS - 1);
        this.show(c, LODS - 1);
      }
  }

  setQuality(q: Quality): void {
    this.quality = q;
  }

  private show(c: Chunk, lod: number): void {
    if (c.cur === lod) return;
    if (c.cur >= 0 && c.lods[c.cur]) c.lods[c.cur]!.visible = false;
    c.cur = lod;
    c.lods[lod]!.visible = true;
  }

  /** Per-frame LOD selection + incremental geometry building. */
  update(cam: THREE.Vector3, budgetMs = 4): void {
    const k = this.quality.terrainLod;
    for (const c of this.chunks) {
      const dx = Math.max(0, Math.abs(cam.x - c.center.x) - CHUNK / 2), dz = Math.max(0, Math.abs(cam.z - c.center.z) - CHUNK / 2);
      const dy = Math.max(0, cam.y - c.maxY - 30);
      const d = Math.sqrt(dx * dx + dz * dz + dy * dy);
      const want = d < 150 * k ? 0 : d < 420 * k ? 1 : d < 1000 * k ? 2 : 3;
      if (c.lods[want]) this.show(c, want);
      else {
        if (!this.queue.some((q) => q.c === c && q.lod === want)) this.queue.push({ c, lod: want });
        // show the best already-built coarser level meanwhile
        for (let l = want + 1; l < LODS; l++) if (c.lods[l]) { this.show(c, l); break; }
      }
    }
    if (this.queue.length) {
      this.queue.sort((a, b) => a.c.center.distanceToSquared(cam) - b.c.center.distanceToSquared(cam));
      const t0 = performance.now();
      while (this.queue.length && performance.now() - t0 < budgetMs) {
        const q = this.queue.shift()!;
        if (!q.c.lods[q.lod]) q.c.lods[q.lod] = this.build(q.c, q.lod);
      }
    }
  }
  get pending(): number {
    return this.queue.length;
  }

  private build(c: Chunk, lod: number): THREE.Mesh {
    const w = this.world;
    const step = 1 << lod;
    const n = CELLS / step + 1;
    const x0 = c.cx * CELLS, z0 = c.cz * CELLS;
    const vcount = n * n + n * 4;
    const pos = new Float32Array(vcount * 3), nor = new Float32Array(vcount * 3), col = new Float32Array(vcount * 3), spl = new Float32Array(vcount * 4);
    const HV = w.heightVis;
    const hAt = (ix: number, iz: number) => HV[Math.min(N - 1, Math.max(0, iz)) * N + Math.min(N - 1, Math.max(0, ix))];
    let v = 0;
    for (let j = 0; j < n; j++) {
      const iz = z0 + j * step;
      const z = iz * RES - WORLD_HALF;
      for (let i = 0; i < n; i++, v++) {
        const ix = x0 + i * step;
        const x = ix * RES - WORLD_HALF;
        let h = hAt(ix, iz);
        if (lod > 0) {
          // keep coarse levels below road decks
          const r = step >> 1;
          for (let oz = -r; oz <= r; oz += Math.max(1, r))
            for (let ox = -r; ox <= r; ox += Math.max(1, r)) {
              const kx = Math.min(N - 1, Math.max(0, ix + ox)), kz = Math.min(N - 1, Math.max(0, iz + oz));
              if (w.roadMask[kz * N + kx] === 1) h = Math.min(h, HV[kz * N + kx]);
            }
        }
        pos[v * 3] = x; pos[v * 3 + 1] = h; pos[v * 3 + 2] = z;
        const s = Math.max(1, step);
        const nx = (hAt(ix - s, iz) - hAt(ix + s, iz)) / (2 * s * RES), nz = (hAt(ix, iz - s) - hAt(ix, iz + s)) / (2 * s * RES);
        const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        nor[v * 3] = nx * il; nor[v * 3 + 1] = il; nor[v * 3 + 2] = nz * il;
        this.shade(ix, iz, x, z, h, il, col, spl, v);
      }
    }
    // skirts
    const skirt = (i: number, j: number) => {
      const src = j * n + i;
      pos[v * 3] = pos[src * 3]; pos[v * 3 + 1] = pos[src * 3 + 1] - (6 + step * 2); pos[v * 3 + 2] = pos[src * 3 + 2];
      nor[v * 3] = nor[src * 3]; nor[v * 3 + 1] = nor[src * 3 + 1]; nor[v * 3 + 2] = nor[src * 3 + 2];
      col[v * 3] = col[src * 3]; col[v * 3 + 1] = col[src * 3 + 1]; col[v * 3 + 2] = col[src * 3 + 2];
      spl[v * 4] = spl[src * 4]; spl[v * 4 + 1] = spl[src * 4 + 1]; spl[v * 4 + 2] = spl[src * 4 + 2]; spl[v * 4 + 3] = spl[src * 4 + 3];
      return v++;
    };
    const quads = (n - 1) * (n - 1) + (n - 1) * 4;
    const idx = vcount > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    let t = 0;
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
        idx[t++] = a; idx[t++] = d; idx[t++] = b;
        idx[t++] = b; idx[t++] = d; idx[t++] = e;
      }
    const edges: [number, number, number, number, boolean][] = [[0, 0, 1, 0, false], [0, n - 1, 1, 0, true], [0, 0, 0, 1, true], [n - 1, 0, 0, 1, false]];
    for (const [si, sj, di, dj, flip] of edges) {
      let prevTop = -1, prevBot = -1;
      for (let k = 0; k < n; k++) {
        const i = si + di * k, j = sj + dj * k;
        const top = j * n + i, bot = skirt(i, j);
        if (k > 0) {
          if (flip) { idx[t++] = prevTop; idx[t++] = top; idx[t++] = prevBot; idx[t++] = top; idx[t++] = bot; idx[t++] = prevBot; }
          else { idx[t++] = prevTop; idx[t++] = prevBot; idx[t++] = top; idx[t++] = top; idx[t++] = prevBot; idx[t++] = bot; }
        }
        prevTop = top; prevBot = bot;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSplat', new THREE.BufferAttribute(spl, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(c.center.clone(), Math.sqrt(2 * (CHUNK / 2) ** 2 + ((c.maxY - c.minY) / 2 + 12) ** 2));
    g.boundingBox = new THREE.Box3(new THREE.Vector3(c.center.x - CHUNK / 2, c.minY - 14, c.center.z - CHUNK / 2), new THREE.Vector3(c.center.x + CHUNK / 2, c.maxY + 2, c.center.z + CHUNK / 2));
    const m = new THREE.Mesh(g, this.material);
    m.receiveShadow = true;
    m.castShadow = lod <= 1;
    m.matrixAutoUpdate = false;
    m.visible = false;
    this.group.add(m);
    return m;
  }

  private shade(ix: number, iz: number, x: number, z: number, h: number, ny: number, col: Float32Array, spl: Float32Array, v: number): void {
    const w = this.world;
    const kx = Math.min(N - 1, ix), kz = Math.min(N - 1, iz);
    const s = w.surface[kz * N + kx] as Surf;
    let c = PALETTE[s], sp = SPLAT[s];
    let r = c[0], g = c[1], b = c[2];
    let s0 = sp[0], s1 = sp[1], s2 = sp[2], s3 = sp[3];
    if (s === Surf.Field) {
      // patchwork of crops
      const fx = Math.floor((x + z * 0.18) / 86), fz = Math.floor((z - x * 0.12) / 64);
      const k = hash2(fx, fz, 4242);
      if (k < 0.3) { r = 0.56; g = 0.47; b = 0.2; } // grain
      else if (k < 0.52) { r = 0.27; g = 0.19; b = 0.12; s0 = 0; s3 = 1; } // ploughed
      else if (k < 0.78) { r = 0.24; g = 0.38; b = 0.11; } // green crop
      else { r = 0.36; g = 0.46; b = 0.14; s0 = 1; s3 = 0; } // meadow
    } else if (s === Surf.Grass) {
      const zn = w.zoneAt(x, z);
      const v2 = noise2(x / 38, z / 38, 808) * 0.5 + 0.5;
      if (zn === Zone.Alpine) { r = 0.3 + v2 * 0.1; g = 0.38 + v2 * 0.04; b = 0.14; }
      else if (zn === Zone.Park) { r = 0.22; g = 0.4; b = 0.11; }
      else { r += (v2 - 0.5) * 0.08; g += (v2 - 0.5) * 0.06; }
    }
    // cliffs and steep cuttings show rock
    const steep = clamp01((0.72 - ny) / 0.16);
    if (steep > 0 && s !== Surf.Asphalt && s !== Surf.Cobble && s !== Surf.Paved) {
      const k = steep * (s === Surf.Snow ? 0.75 : 1);
      r += (0.37 - r) * k; g += (0.36 - g) * k; b += (0.345 - b) * k;
      s0 *= 1 - k; s2 *= 1 - k; s3 *= 1 - k; s1 += (1 - s1) * k;
    }
    // lake / river bed
    if (h < 0.1) {
      const k = clamp01(-h / 5);
      r += (0.2 - r) * (0.4 + 0.6 * k); g += (0.26 - g) * (0.4 + 0.6 * k); b += (0.2 - b) * (0.4 + 0.6 * k);
    }
    col[v * 3] = r; col[v * 3 + 1] = g; col[v * 3 + 2] = b;
    spl[v * 4] = s0; spl[v * 4 + 1] = s1; spl[v * 4 + 2] = s2; spl[v * 4 + 3] = s3;
  }
}
