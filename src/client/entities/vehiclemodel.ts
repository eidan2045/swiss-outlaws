// Procedural vehicle models: lofted bodies with wheel arches, glass, lights and a single patched physical material.
import * as THREE from 'three';
import { VehicleSpec, VF } from '../../shared/sim/types';
import { U, replaceOnce } from '../render/globals';

/** material ids stored per vertex */
const M = { PAINT: 0, GLASS: 1, TRIM: 2, HEAD: 3, TAIL: 4, CHROME: 5, PLATE: 6, SIREN_L: 7, SIREN_R: 8, LIVERY: 9, REVERSE: 10 };

export const PAINTS: number[] = [
  0xd9d9d6, 0x1b1d20, 0x6a6e73, 0xb3161b, 0x1f3f7a, 0xe8e6df, 0x2e4d3a, 0x8a8d90,
  0xc8a23a, 0x3a3f46, 0x7a1e2c, 0x2b6a8a, 0xf2f2ee, 0x4a2f22, 0x9aa7b0, 0xd35f1a,
];

interface Shape {
  /** profile of the body top (z from front +L/2 to rear -L/2, y height) */
  top: [number, number][];
  /** belt line (where glass starts) */
  belt: [number, number][];
  /** tumblehome inset of the roof as a fraction of half width */
  inset: number;
  /** ground clearance of the sills */
  sill: number;
  /** z range of the cabin (glass) */
  cabin: [number, number];
  spoiler?: boolean;
  lightbar?: boolean;
  livery?: boolean;
  bus?: boolean;
}

function shapeFor(spec: VehicleSpec): Shape {
  const L = spec.length, f = L / 2, H = spec.height;
  switch (spec.cls) {
    case 'sport':
      return { top: [[f, 0.5], [f - 0.12, 0.62], [f - 1.35, 0.8], [f - 2.2, H], [f - 3.05, H - 0.02], [-f + 0.5, 0.86], [-f + 0.06, 0.84], [-f, 0.66]], belt: [[f, 0.5], [f - 1.35, 0.78], [-f + 0.6, 0.84], [-f, 0.66]], inset: 0.3, sill: 0.17, cabin: [f - 1.3, -f + 0.55], spoiler: true };
    case 'sedan':
    case 'police':
      return { top: [[f, 0.56], [f - 0.1, 0.7], [f - 1.25, 0.9], [f - 2.05, H], [f - 3.35, H - 0.01], [-f + 0.95, 1.0], [-f + 0.08, 0.96], [-f, 0.72]], belt: [[f, 0.56], [f - 1.25, 0.88], [-f + 0.95, 0.96], [-f, 0.72]], inset: 0.24, sill: 0.2, cabin: [f - 1.2, -f + 0.98], lightbar: spec.cls === 'police', livery: spec.cls === 'police' };
    case 'suv':
      return { top: [[f, 0.72], [f - 0.08, 0.9], [f - 1.15, 1.08], [f - 1.85, H], [-f + 0.5, H - 0.02], [-f + 0.1, 1.24], [-f, 0.84]], belt: [[f, 0.72], [f - 1.15, 1.06], [-f + 0.3, 1.1], [-f, 0.84]], inset: 0.16, sill: 0.3, cabin: [f - 1.12, -f + 0.14] };
    case 'van':
      return { top: [[f, 0.78], [f - 0.06, 1.0], [f - 0.62, 1.22], [f - 1.3, H], [-f + 0.08, H - 0.02], [-f, H - 0.3]], belt: [[f, 0.78], [f - 0.62, 1.2], [f - 1.9, 1.24], [f - 1.92, H - 0.06], [-f, H - 0.3]], inset: 0.07, sill: 0.28, cabin: [f - 0.6, f - 1.9] };
    case 'bus':
      return { top: [[f, 1.2], [f - 0.05, H - 0.4], [f - 0.4, H], [-f + 0.2, H], [-f, H - 0.2]], belt: [[f, 1.2], [f - 0.4, 1.25], [-f + 0.3, 1.25], [-f, 1.3]], inset: 0.04, sill: 0.36, cabin: [f - 0.38, -f + 0.3], bus: true };
    default: // compact hatchback
      return { top: [[f, 0.58], [f - 0.08, 0.72], [f - 1.0, 0.92], [f - 1.75, H], [-f + 0.7, H - 0.03], [-f + 0.12, 1.0], [-f, 0.72]], belt: [[f, 0.58], [f - 1.0, 0.9], [-f + 0.2, 0.96], [-f, 0.72]], inset: 0.22, sill: 0.2, cabin: [f - 0.96, -f + 0.16] };
  }
}
function interp(pts: [number, number][], z: number): number {
  // pts sorted by descending z
  if (z >= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (z <= a[0] && z >= b[0]) {
      const t = a[0] === b[0] ? 0 : (a[0] - z) / (a[0] - b[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return pts[pts.length - 1][1];
}

interface BodyGeo { body: THREE.BufferGeometry; wheel: THREE.BufferGeometry }
const cache = new Map<number, BodyGeo>();

class VB {
  pos: number[] = []; nor: number[] = []; mat: number[] = []; idx: number[] = [];
  n = 0;
  v(x: number, y: number, z: number, m: number): number {
    this.pos.push(x, y, z);
    this.nor.push(0, 0, 0);
    this.mat.push(m);
    return this.n++;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  /** flat-shaded box */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, m: number): void {
    const c = [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]];
    const faces = [[0, 1, 2, 3], [5, 4, 7, 6], [1, 5, 6, 2], [4, 0, 3, 7], [3, 2, 6, 7], [4, 5, 1, 0]];
    for (const f of faces) {
      const i = f.map((k) => this.v(cx + c[k][0] * hx, cy + c[k][1] * hy, cz + c[k][2] * hz, m));
      this.quad(i[0], i[1], i[2], i[3]);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(this.mat), 1));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

function buildBody(spec: VehicleSpec): THREE.BufferGeometry {
  const sh = shapeFor(spec);
  const L = spec.length, f = L / 2, hw = spec.width / 2;
  const R = spec.wheelR, Ra = R + 0.075;
  const zwF = spec.wheelbase / 2, zwR = -spec.wheelbase / 2;
  // stations along z
  const zs = new Set<number>();
  const add = (z: number) => zs.add(Math.round(Math.max(-f, Math.min(f, z)) * 1000) / 1000);
  for (const p of sh.top) add(p[0]);
  for (const p of sh.belt) add(p[0]);
  for (const zw of [zwF, zwR]) for (const k of [-1.12, -1, -0.86, -0.6, -0.3, 0, 0.3, 0.6, 0.86, 1, 1.12]) add(zw + k * Ra);
  add(f - 0.04); add(-f + 0.04);
  for (let z = -f; z <= f; z += 0.4) add(z);
  const Z = [...zs].sort((a, b) => b - a);
  const vb = new VB();
  const RING = 11;
  const rings: number[][] = [];
  const roofLevel: boolean[] = [];
  for (const z of Z) {
    const top = interp(sh.top, z), belt = Math.min(interp(sh.belt, z), top - 0.02);
    const endT = Math.min(1, Math.min(f - z, z + f) / 0.5);
    const taper = 1 - 0.16 * (1 - endT) * (1 - endT) - (sh.bus ? 0 : 0.03 * (1 - Math.min(1, (f - Math.abs(z)) / 1.2)));
    const w = hw * taper;
    let yb = sh.sill + (1 - endT) * 0.12;
    for (const zw of [zwF, zwR]) {
      const d = z - zw;
      if (Math.abs(d) < Ra) yb = Math.max(yb, R + Math.sqrt(Ra * Ra - d * d));
    }
    yb = Math.min(yb, belt - 0.06);
    const cabin = z <= sh.cabin[0] + 0.001 && z >= sh.cabin[1] - 0.001 && top - belt > 0.12;
    roofLevel.push(cabin);
    const inset = cabin ? sh.inset * hw : hw * 0.07;
    const crown = cabin ? 0.035 : 0.025;
    const mid = yb + (belt - yb) * 0.55;
    // right half ring: [x, y, mat]
    const half: [number, number, number][] = [
      [0, yb + 0.02, M.TRIM],
      [w * 0.86, yb, M.TRIM],
      [w, yb + 0.07, M.TRIM],
      [w, yb + 0.12, M.PAINT],
      [w * 1.005, mid, M.PAINT],
      [w * 0.985, belt, M.PAINT],
      [w * 0.985, belt, cabin ? M.GLASS : M.PAINT],
      [w - inset * 0.45, belt + (top - belt) * 0.55, cabin ? M.GLASS : M.PAINT],
      [w - inset, top - 0.035, cabin ? M.GLASS : M.PAINT],
      [w - inset, top - 0.035, M.PAINT],
      [(w - inset) * 0.72, top, M.PAINT],
    ];
    void RING;
    const ring: number[] = [];
    // left side (x negative) from top centre down, then right side up → full closed ring ordered around
    ring.push(vb.v(0, top + crown, z, M.PAINT));
    for (let k = half.length - 1; k >= 0; k--) ring.push(vb.v(-half[k][0], half[k][1], z, half[k][2]));
    for (let k = 1; k < half.length; k++) ring.push(vb.v(half[k][0], half[k][1], z, half[k][2]));
    ring.push(vb.v(0, top + crown, z, M.PAINT));
    rings.push(ring);
  }
  // skin between rings; windshield / rear window where the roof level changes
  for (let i = 0; i < Z.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    const trans = roofLevel[i] !== roofLevel[i + 1];
    const n = a.length;
    for (let k = 0; k < n - 1; k++) {
      // ring is ordered: top centre, left side going down, bottom centre, right side going up, top centre
      vb.quad(a[k], b[k], b[k + 1], a[k + 1]);
      if (trans) {
        // top panels (between the roof edge points and the centre) become glass
        const topPanel = k <= 1 || k >= n - 3;
        if (topPanel) for (const id of [a[k], a[k + 1], b[k], b[k + 1]]) if (vb.mat[id] === M.PAINT && vb.pos[id * 3 + 1] > 0) { /* keep paint on shared verts */ }
      }
    }
    if (trans) {
      // dedicated glass panel slightly above the body surface (windshield / rear window)
      const hi = roofLevel[i] ? i : i + 1, lo = roofLevel[i] ? i + 1 : i;
      const zHi = Z[hi], zLo = Z[lo];
      const topHi = interp(sh.top, zHi), topLo = interp(sh.top, zLo);
      const wHi = (hw - sh.inset * hw) * 0.96, wLo = hw * 0.86;
      const e = 0.012;
      const v0 = vb.v(-wLo, topLo + e, zLo, M.GLASS), v1 = vb.v(wLo, topLo + e, zLo, M.GLASS), v2 = vb.v(wHi, topHi + e, zHi, M.GLASS), v3 = vb.v(-wHi, topHi + e, zHi, M.GLASS);
      if (zLo > zHi) vb.quad(v0, v1, v2, v3);
      else vb.quad(v1, v0, v3, v2);
    }
  }
  // end caps
  const cap = (ring: number[], front: boolean) => {
    const c = vb.v(0, 0.5, front ? f : -f, M.PAINT);
    const cy = (vb.pos[ring[0] * 3 + 1] + vb.pos[ring[Math.floor(ring.length / 2)] * 3 + 1]) / 2;
    vb.pos[c * 3 + 1] = cy;
    for (let k = 0; k < ring.length - 1; k++) {
      const p = vb.v(vb.pos[ring[k] * 3], vb.pos[ring[k] * 3 + 1], vb.pos[ring[k] * 3 + 2], M.PAINT);
      const q = vb.v(vb.pos[ring[k + 1] * 3], vb.pos[ring[k + 1] * 3 + 1], vb.pos[ring[k + 1] * 3 + 2], M.PAINT);
      if (front) vb.tri(c, q, p);
      else vb.tri(c, p, q);
    }
  };
  cap(rings[0], true);
  cap(rings[rings.length - 1], false);

  // ---- details
  const noseTop = interp(sh.top, f - 0.05), tailTop = interp(sh.top, -f + 0.05);
  const fw = hw * 0.84;
  // bumpers
  vb.box(0, sh.sill + 0.17, f - 0.02, fw, 0.13, 0.06, M.TRIM);
  vb.box(0, sh.sill + 0.17, -f + 0.02, fw, 0.13, 0.06, M.TRIM);
  // grille + lights
  vb.box(0, noseTop - 0.2, f + 0.012, fw * 0.42, 0.07, 0.02, M.CHROME);
  for (const s of [-1, 1]) {
    vb.box(s * fw * 0.72, noseTop - 0.14, f + 0.006, fw * 0.2, 0.06, 0.03, M.HEAD);
    vb.box(s * fw * 0.72, tailTop - 0.14, -f - 0.006, fw * 0.22, 0.055, 0.03, M.TAIL);
    vb.box(s * fw * 0.36, tailTop - 0.14, -f - 0.004, fw * 0.09, 0.04, 0.02, M.REVERSE);
    // mirrors
    if (!sh.bus) vb.box(s * (hw + 0.07), interp(sh.belt, sh.cabin[0] - 0.25) + 0.05, sh.cabin[0] - 0.28, 0.08, 0.055, 0.045, M.PAINT);
    else vb.box(s * (hw + 0.14), 2.2, f - 0.2, 0.05, 0.2, 0.06, M.TRIM);
  }
  // plates
  vb.box(0, sh.sill + 0.2, f + 0.045, 0.24, 0.055, 0.008, M.PLATE);
  vb.box(0, tailTop - 0.36, -f - 0.035, 0.22, 0.07, 0.008, M.PLATE);
  if (sh.spoiler) {
    vb.box(0, tailTop + 0.17, -f + 0.2, hw * 0.86, 0.018, 0.13, M.TRIM);
    for (const s of [-1, 1]) vb.box(s * hw * 0.6, tailTop + 0.08, -f + 0.2, 0.02, 0.08, 0.07, M.TRIM);
  }
  if (sh.lightbar) {
    const roofY = spec.height;
    vb.box(0, roofY + 0.07, 0.1, 0.5, 0.045, 0.14, M.TRIM);
    vb.box(-0.3, roofY + 0.08, 0.1, 0.2, 0.05, 0.12, M.SIREN_L);
    vb.box(0.3, roofY + 0.08, 0.1, 0.2, 0.05, 0.12, M.SIREN_R);
  }
  if (sh.livery) {
    // orange side stripe
    for (const s of [-1, 1]) vb.box(s * (hw + 0.012), 0.7, 0, 0.006, 0.09, L * 0.36, M.LIVERY);
  }
  if (sh.bus) {
    // destination display + door outlines
    vb.box(0, spec.height - 0.22, f + 0.01, 0.9, 0.12, 0.01, M.HEAD);
  }
  return vb.build();
}

function buildWheel(): THREE.BufferGeometry {
  // unit wheel: radius 1, width 1 (scaled per vehicle); axis along x
  const vb = new VB();
  const N = 18;
  const ringAt = (x: number, r: number, m: number) => {
    const ids: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      ids.push(vb.v(x, Math.cos(a) * r, Math.sin(a) * r, m));
    }
    return ids;
  };
  const strip = (a: number[], b: number[]) => {
    for (let i = 0; i < N; i++) vb.quad(a[i], a[(i + 1) % N], b[(i + 1) % N], b[i]);
  };
  // tyre tread + side walls
  strip(ringAt(-0.5, 1, M.TRIM), ringAt(0.5, 1, M.TRIM));
  strip(ringAt(0.5, 1, M.TRIM), ringAt(0.5, 0.66, M.TRIM));
  strip(ringAt(-0.5, 0.66, M.TRIM), ringAt(-0.5, 1, M.TRIM));
  // rim (both sides) with a dish
  strip(ringAt(0.5, 0.66, M.CHROME), ringAt(0.36, 0.56, M.CHROME));
  strip(ringAt(-0.36, 0.56, M.CHROME), ringAt(-0.5, 0.66, M.CHROME));
  for (const sx of [1, -1]) {
    const c = vb.v(sx * 0.4, 0, 0, M.CHROME);
    const r = ringAt(sx * 0.36, 0.56, M.CHROME);
    for (let i = 0; i < N; i++) {
      if (sx > 0) vb.tri(c, r[i], r[(i + 1) % N]);
      else vb.tri(c, r[(i + 1) % N], r[i]);
    }
    // spokes
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const y = Math.cos(a) * 0.3, z = Math.sin(a) * 0.3;
      vb.box(sx * 0.44, y, z, 0.03, Math.abs(Math.cos(a)) * 0.24 + 0.05, Math.abs(Math.sin(a)) * 0.24 + 0.05, M.TRIM);
    }
  }
  return vb.build();
}

let baseMat: THREE.MeshPhysicalMaterial | null = null;
let wheelGeo: THREE.BufferGeometry | null = null;

interface VehUniforms {
  uPaint: { value: THREE.Color };
  /** x head, y tail, z brake, w reverse */
  uLights: { value: THREE.Vector4 };
  uSiren: { value: number };
  uDirt: { value: number };
}

function makeMaterial(u: VehUniforms): THREE.MeshPhysicalMaterial {
  if (!baseMat) baseMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.25 });
  const m = baseMat.clone();
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uPaint = u.uPaint;
    sh.uniforms.uLights = u.uLights;
    sh.uniforms.uSiren = u.uSiren;
    sh.uniforms.uDirt = u.uDirt;
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uWet = U.uWet;
    sh.vertexShader = replaceOnce(sh.vertexShader, '#include <common>', '#include <common>\nattribute float aMat;\nvarying float vMat;\nvarying float vLY;');
    sh.vertexShader = replaceOnce(sh.vertexShader, '#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat;\nvLY = position.y;');
    sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <common>', `#include <common>
uniform vec3 uPaint; uniform vec4 uLights; uniform float uSiren; uniform float uDirt; uniform float uTime; uniform float uWet;
varying float vMat; varying float vLY;
float gCoat; vec3 gEmis;
bool isM(float id) { return abs(vMat - id) < 0.5; }`);
    sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <color_fragment>', `#include <color_fragment>
{
  gCoat = 0.0; gEmis = vec3(0.0);
  vec3 c = uPaint;
  if (isM(0.0)) { gCoat = 1.0; }
  else if (isM(1.0)) { c = vec3(0.015, 0.02, 0.026); gCoat = 1.0; }
  else if (isM(2.0)) { c = vec3(0.022, 0.023, 0.025); }
  else if (isM(3.0)) { c = vec3(0.82, 0.84, 0.86); gEmis = vec3(1.0, 0.95, 0.85) * uLights.x * 7.0; }
  else if (isM(4.0)) { c = vec3(0.35, 0.01, 0.01); gEmis = vec3(1.0, 0.04, 0.02) * (uLights.y * 1.4 + uLights.z * 6.0); }
  else if (isM(5.0)) { c = vec3(0.55, 0.56, 0.58); }
  else if (isM(6.0)) { c = vec3(0.86, 0.86, 0.82); }
  else if (isM(7.0)) { c = vec3(0.03, 0.06, 0.25); gEmis = vec3(0.05, 0.25, 1.0) * uSiren * step(0.5, fract(uTime * 2.6)) * 14.0; }
  else if (isM(8.0)) { c = vec3(0.03, 0.06, 0.25); gEmis = vec3(0.05, 0.25, 1.0) * uSiren * step(0.5, fract(uTime * 2.6 + 0.5)) * 14.0; }
  else if (isM(9.0)) { c = vec3(0.9, 0.32, 0.03); }
  else { c = vec3(0.8, 0.8, 0.8); gEmis = vec3(1.0) * uLights.w * 3.0; }
  // road grime builds up from the sills
  float dirt = uDirt * smoothstep(0.75, 0.15, vLY);
  c = mix(c, vec3(0.16, 0.13, 0.1), dirt * 0.7);
  diffuseColor.rgb = c;
}`);
    sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
if (isM(0.0)) roughnessFactor = 0.42;
else if (isM(1.0)) roughnessFactor = 0.04;
else if (isM(2.0)) roughnessFactor = 0.72;
else if (isM(5.0)) roughnessFactor = 0.18;
else roughnessFactor = 0.3;
roughnessFactor = mix(roughnessFactor, 0.85, uDirt * smoothstep(0.75, 0.15, vLY));`);
    sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
if (isM(0.0)) metalnessFactor = 0.45;
else if (isM(1.0)) metalnessFactor = 0.9;
else if (isM(5.0)) metalnessFactor = 1.0;
else metalnessFactor = 0.0;`);
    sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat *= gCoat;
#endif`);
    sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmis;');
  };
  m.customProgramCacheKey = () => 'vehicle';
  return m;
}

export class VehicleModel {
  readonly group = new THREE.Group();
  readonly body: THREE.Mesh;
  readonly wheels: THREE.Mesh[] = [];
  private u: VehUniforms;
  private spin = 0;
  private headLight: THREE.SpotLight | null = null;
  /** local wheel anchor positions (x, z) */
  private anchors: [number, number][];
  dirt = 0;

  constructor(readonly spec: VehicleSpec, color: number) {
    let geo = cache.get(spec.id);
    if (!geo) {
      geo = { body: buildBody(spec), wheel: wheelGeo ?? (wheelGeo = buildWheel()) };
      cache.set(spec.id, geo);
    }
    const paint = spec.cls === 'police' ? 0xf2f2ee : spec.cls === 'bus' ? 0x1b4f9c : PAINTS[color % PAINTS.length];
    this.u = { uPaint: { value: new THREE.Color(paint) }, uLights: { value: new THREE.Vector4(0, 0, 0, 0) }, uSiren: { value: 0 }, uDirt: { value: 0 } };
    const mat = makeMaterial(this.u);
    this.body = new THREE.Mesh(geo.body, mat);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    // body geometry is modelled with y = 0 at the ground; the entity origin sits at ride height
    this.body.position.y = -spec.ride;
    this.group.add(this.body);
    const hw = spec.track / 2, hl = spec.wheelbase / 2;
    this.anchors = [[hw, hl], [-hw, hl], [hw, -hl], [-hw, -hl]];
    const tw = spec.cls === 'bus' ? 0.3 : spec.cls === 'sport' ? 0.27 : 0.22;
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(geo.wheel, mat);
      w.scale.set(tw, spec.wheelR, spec.wheelR);
      w.castShadow = true;
      w.rotation.order = 'YXZ';
      this.group.add(w);
      this.wheels.push(w);
    }
  }

  /** Real spot light for the local player's headlights. */
  enableHeadlight(on: boolean): void {
    if (on && !this.headLight) {
      const l = new THREE.SpotLight(0xfff0d8, 0, 70, 0.6, 0.6, 1.4);
      l.position.set(0, 0.35, this.spec.length / 2 - 0.2);
      l.target.position.set(0, -0.6, this.spec.length / 2 + 14);
      this.group.add(l, l.target);
      this.headLight = l;
    } else if (!on && this.headLight) {
      this.group.remove(this.headLight, this.headLight.target);
      this.headLight.dispose();
      this.headLight = null;
    }
  }

  /**
   * @param groundAt world ground query used to keep the wheels on the road
   */
  update(dt: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, speed: number, steer: number, flags: number, groundAt: (x: number, z: number, y: number) => number, night: number): void {
    const g = this.group;
    g.position.set(x, y, z);
    g.rotation.set(-pitch, yaw, roll, 'YXZ');
    this.spin += (speed / this.spec.wheelR) * dt;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const R = this.spec.wheelR;
    const rest = -this.spec.ride + R;
    for (let i = 0; i < 4; i++) {
      const [ax, az] = this.anchors[i];
      const w = this.wheels[i];
      // keep the tyre on the ground within the suspension travel
      const wx = x + cos * ax + sin * az, wz = z - sin * ax + cos * az;
      const gy = groundAt(wx, wz, y + 0.5);
      const ly = gy + R - y - az * pitch - ax * roll;
      w.position.set(ax, Math.max(rest - 0.14, Math.min(rest + 0.17, ly)), az);
      w.rotation.y = i < 2 ? steer * this.spec.steerMax : 0;
      w.rotation.x = this.spin;
    }
    const lightsOn = (flags & VF.LIGHTS) !== 0;
    const L = this.u.uLights.value;
    L.x = lightsOn ? 1 : 0.0;
    L.y = lightsOn ? 1 : 0;
    L.z = flags & VF.BRAKE ? 1 : 0;
    L.w = flags & VF.REVERSE ? 1 : 0;
    this.u.uSiren.value = flags & VF.SIREN ? 1 : 0;
    this.u.uDirt.value = this.dirt;
    if (this.headLight) this.headLight.intensity = lightsOn ? 260 * Math.max(0.25, night) : 0;
  }

  dispose(): void {
    (this.body.material as THREE.Material).dispose();
    this.enableHeadlight(false);
  }
}
