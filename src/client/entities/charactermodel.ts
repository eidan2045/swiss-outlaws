// Procedural rigged character: skinned mesh (17 bones) generated from an appearance, animated by a
// parametric pose system with two-bone leg IK (speed-synchronised gait → no foot sliding), terrain foot
// placement, upper-body overlays (aim, punch) and ragdoll-like knock-down poses.
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../../shared/math';
import { Appearance } from '../../shared/net/protocol';

const B = { hips: 0, spine: 1, chest: 2, neck: 3, head: 4, uArmL: 5, fArmL: 6, handL: 7, uArmR: 8, fArmR: 9, handR: 10, thighL: 11, shinL: 12, footL: 13, thighR: 14, shinR: 15, footR: 16 };
const PARENT = [-1, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15];
const REST: [number, number, number][] = [
  [0, 0.95, 0], [0, 1.08, 0], [0, 1.26, 0], [0, 1.47, 0], [0, 1.55, 0],
  [0.19, 1.42, 0], [0.46, 1.42, 0], [0.71, 1.42, 0],
  [-0.19, 1.42, 0], [-0.46, 1.42, 0], [-0.71, 1.42, 0],
  [0.095, 0.92, 0], [0.095, 0.5, 0], [0.095, 0.085, 0],
  [-0.095, 0.92, 0], [-0.095, 0.5, 0], [-0.095, 0.085, 0],
];
const L1 = 0.42, L2 = 0.415, HIP_Y = 0.92, ANKLE = 0.085;

export const SKIN = [0xf1c9a5, 0xe0ac7e, 0xc68642, 0x8d5524, 0x5c3a1e];
export const HAIR = [0x1c1410, 0x4a2f1b, 0x8a5a2b, 0xd6b370, 0x9a9a9a, 0xa33a1a];
export const JACKET = [0x1f2a3a, 0x7a1f1f, 0x2f5d3a, 0xd9d4c7, 0x3a3a3c, 0xc8a030, 0x1b4f7a, 0x5a3a22, 0xe2e2e2, 0x703060, 0x202022, 0xd35f1a, 0x2e6e6a, 0x8a8f96, 0x46503a, 0xb3161b];
export const PANTS = [0x1c2233, 0x2b2b2e, 0x4a4a52, 0x6b5a45, 0x23324a, 0x3c4a2e, 0x8a8370, 0x15151a];
export const SHOES = [0x15151a, 0x4a2f1b, 0xe8e8e8, 0x7a1f1f];

// ---------------------------------------------------------------- mesh generation
interface Ring { c: [number, number, number]; u: [number, number, number]; v: [number, number, number]; ru: number; rv: number; col: number; w: [number, number][] }
class Skin {
  pos: number[] = []; col: number[] = []; si: number[] = []; sw: number[] = []; idx: number[] = [];
  n = 0;
  vert(x: number, y: number, z: number, col: number, w: [number, number][]): number {
    this.pos.push(x, y, z);
    const c = new THREE.Color(col);
    this.col.push(c.r, c.g, c.b);
    const a = w[0], b = w[1] ?? [0, 0];
    const t = a[1] + b[1] || 1;
    this.si.push(a[0], b[0], 0, 0);
    this.sw.push(a[1] / t, b[1] / t, 0, 0);
    return this.n++;
  }
  tube(rings: Ring[], sides: number, capStart = false, capEnd = false): void {
    const ids: number[][] = [];
    for (const r of rings) {
      const row: number[] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const cu = Math.cos(a) * r.ru, cv = Math.sin(a) * r.rv;
        row.push(this.vert(r.c[0] + r.u[0] * cu + r.v[0] * cv, r.c[1] + r.u[1] * cu + r.v[1] * cv, r.c[2] + r.u[2] * cu + r.v[2] * cv, r.col, r.w));
      }
      ids.push(row);
    }
    for (let k = 0; k < ids.length - 1; k++)
      for (let i = 0; i < sides; i++) {
        const a = ids[k][i], b = ids[k][(i + 1) % sides], c = ids[k + 1][(i + 1) % sides], d = ids[k + 1][i];
        this.idx.push(a, b, c, a, c, d);
      }
    const cap = (row: number[], r: Ring, flip: boolean) => {
      const c = this.vert(r.c[0], r.c[1], r.c[2], r.col, r.w);
      for (let i = 0; i < sides; i++) {
        if (flip) this.idx.push(c, row[(i + 1) % sides], row[i]);
        else this.idx.push(c, row[i], row[(i + 1) % sides]);
      }
    };
    if (capStart) cap(ids[0], rings[0], true);
    if (capEnd) cap(ids[ids.length - 1], rings[rings.length - 1], false);
  }
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, col: number, w: [number, number][]): void {
    const c = [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]];
    const faces = [[0, 1, 2, 3], [5, 4, 7, 6], [1, 5, 6, 2], [4, 0, 3, 7], [3, 2, 6, 7], [4, 5, 1, 0]];
    for (const f of faces) {
      const i = f.map((k) => this.vert(cx + c[k][0] * hx, cy + c[k][1] * hy, cz + c[k][2] * hz, col, w));
      this.idx.push(i[0], i[1], i[2], i[0], i[2], i[3]);
    }
  }
}
const X: [number, number, number] = [1, 0, 0], Y: [number, number, number] = [0, 1, 0], Z: [number, number, number] = [0, 0, 1];

const geoCache = new Map<string, THREE.BufferGeometry>();
function buildGeometry(a: Appearance, police: boolean): THREE.BufferGeometry {
  const key = JSON.stringify(a) + (police ? 'P' : '');
  const cached = geoCache.get(key);
  if (cached) return cached;
  const s = new Skin();
  const skin = SKIN[a.skin % SKIN.length], hair = HAIR[a.hair % HAIR.length];
  const jacket = police ? 0x15233b : JACKET[a.jacket % JACKET.length], pants = police ? 0x141c2c : PANTS[a.pants % PANTS.length], shoes = police ? 0x0e0e10 : SHOES[a.shoes % SHOES.length];
  const bw = [0.92, 1.0, 1.1][a.build % 3], bd = [0.94, 1.0, 1.1][a.build % 3];
  const wy = (y: number): [number, number][] => {
    if (y < 1.0) return [[B.hips, 1]];
    if (y < 1.12) { const t = smoothstep(0.98, 1.12, y); return [[B.hips, 1 - t], [B.spine, t]]; }
    if (y < 1.3) { const t = smoothstep(1.14, 1.3, y); return [[B.spine, 1 - t], [B.chest, t]]; }
    if (y < 1.5) { const t = smoothstep(1.44, 1.5, y); return [[B.chest, 1 - t], [B.neck, t]]; }
    const t = smoothstep(1.5, 1.56, y);
    return [[B.neck, 1 - t], [B.head, t]];
  };
  // ring axes are chosen so that u × v points along the loft direction (outward-facing triangles)
  const tr = (y: number, rx: number, rz: number, col: number, cz = 0): Ring => ({ c: [0, y, cz], u: Z, v: X, ru: rz * bd, rv: rx * bw, col, w: wy(y) });
  // torso
  s.tube([
    tr(0.86, 0.12, 0.09, pants), tr(0.9, 0.158, 0.106, pants), tr(0.97, 0.166, 0.112, pants), tr(1.01, 0.168, 0.113, pants),
    tr(1.0, 0.178, 0.122, jacket), tr(1.1, 0.158, 0.108, jacket), tr(1.24, 0.174, 0.12, jacket, 0.004), tr(1.36, 0.186, 0.116, jacket, 0.002), tr(1.43, 0.168, 0.1, jacket), tr(1.475, 0.078, 0.074, jacket),
    tr(1.47, 0.05, 0.054, skin), tr(1.53, 0.05, 0.056, skin, 0.004),
  ], 12, true, false);
  // head
  const hr = (y: number, rx: number, rz: number, cz: number, col = skin): Ring => ({ c: [0, y, cz], u: Z, v: X, ru: rz, rv: rx, col, w: [[B.head, 1]] });
  s.tube([hr(1.53, 0.052, 0.058, 0.006), hr(1.565, 0.068, 0.08, 0.012), hr(1.61, 0.079, 0.093, 0.012), hr(1.66, 0.083, 0.098, 0.008), hr(1.71, 0.081, 0.097, 0.004), hr(1.755, 0.064, 0.078, 0), hr(1.785, 0.03, 0.036, 0)], 12, false, true);
  // nose, eyes, mouth hint
  s.box(0, 1.635, 0.108, 0.011, 0.02, 0.012, skin, [[B.head, 1]]);
  for (const sx of [-1, 1]) s.box(sx * 0.031, 1.668, 0.0935, 0.011, 0.006, 0.004, 0x1a1512, [[B.head, 1]]);
  s.box(0, 1.596, 0.092, 0.018, 0.003, 0.004, 0x7a4a40, [[B.head, 1]]);
  for (const sx of [-1, 1]) s.box(sx * 0.084, 1.645, 0.004, 0.006, 0.022, 0.013, skin, [[B.head, 1]]);
  // hair / headwear
  if (police) {
    s.tube([hr(1.7, 0.09, 0.104, 0.004, 0x10182a), hr(1.75, 0.092, 0.106, 0.004, 0x10182a), hr(1.79, 0.088, 0.1, 0.002, 0x10182a), hr(1.8, 0.02, 0.02, 0, 0x10182a)], 12, false, true);
    s.box(0, 1.705, 0.11, 0.07, 0.006, 0.04, 0x0b101c, [[B.head, 1]]);
  } else if (a.hat === 1) {
    const cap = JACKET[(a.jacket + 5) % JACKET.length];
    s.tube([hr(1.69, 0.088, 0.103, 0.004, cap), hr(1.74, 0.086, 0.1, 0.002, cap), hr(1.785, 0.06, 0.072, 0, cap), hr(1.8, 0.02, 0.02, 0, cap)], 12, false, true);
    s.box(0, 1.698, 0.115, 0.062, 0.005, 0.045, cap, [[B.head, 1]]);
    s.tube([hr(1.6, 0.084, 0.07, -0.04, hair), hr(1.69, 0.087, 0.085, -0.025, hair)], 10);
  } else if (a.hairStyle !== 2) {
    const long = a.hairStyle === 1, big = a.hairStyle === 3;
    const rings: Ring[] = [];
    if (long) rings.push(hr(1.49, 0.07, 0.05, -0.052, hair), hr(1.55, 0.088, 0.066, -0.042, hair));
    rings.push(hr(1.615, 0.089, 0.082, -0.03, hair), hr(1.67, 0.09 + (big ? 0.012 : 0), 0.098 + (big ? 0.01 : 0), -0.016, hair), hr(1.725, 0.088 + (big ? 0.014 : 0), 0.103 + (big ? 0.01 : 0), -0.006, hair), hr(1.775, 0.07 + (big ? 0.012 : 0), 0.084, -0.002, hair), hr(1.802 + (big ? 0.012 : 0), 0.025, 0.03, 0, hair));
    s.tube(rings, 12, long, true);
  }
  // arms (T-pose along ±x)
  for (const sx of [1, -1]) {
    const U = sx > 0 ? B.uArmL : B.uArmR, F = sx > 0 ? B.fArmL : B.fArmR, H = sx > 0 ? B.handL : B.handR;
    const aw = (x: number): [number, number][] => {
      if (x < 0.25) { const t = smoothstep(0.13, 0.24, x); return [[B.chest, 1 - t], [U, t]]; }
      if (x < 0.56) { const t = smoothstep(0.4, 0.52, x); return [[U, 1 - t], [F, t]]; }
      const t = smoothstep(0.66, 0.74, x);
      return [[F, 1 - t], [H, t]];
    };
    const ar = (x: number, ry: number, rz: number, col: number, cy = 1.42): Ring => ({ c: [sx * x, cy, 0], u: Y, v: sx > 0 ? Z : [0, 0, -1], ru: ry * bw, rv: rz * bw, col, w: aw(x) });
    s.tube([ar(0.14, 0.07, 0.07, jacket, 1.4), ar(0.2, 0.062, 0.064, jacket, 1.415), ar(0.32, 0.05, 0.053, jacket), ar(0.45, 0.044, 0.046, jacket), ar(0.58, 0.04, 0.043, jacket), ar(0.69, 0.034, 0.038, jacket),
      ar(0.69, 0.028, 0.033, skin), ar(0.73, 0.022, 0.037, skin), ar(0.8, 0.018, 0.042, skin), ar(0.865, 0.014, 0.036, skin), ar(0.895, 0.006, 0.016, skin)], 8, true, true);
  }
  // legs
  for (const sx of [1, -1]) {
    const T = sx > 0 ? B.thighL : B.thighR, S = sx > 0 ? B.shinL : B.shinR, F = sx > 0 ? B.footL : B.footR;
    const lw = (y: number): [number, number][] => {
      if (y > 0.8) { const t = smoothstep(0.98, 0.84, y); return [[B.hips, 1 - t], [T, t]]; }
      if (y > 0.3) { const t = smoothstep(0.56, 0.44, y); return [[T, 1 - t], [S, t]]; }
      const t = smoothstep(0.14, 0.07, y);
      return [[S, 1 - t], [F, t]];
    };
    const lr = (y: number, rx: number, rz: number, col: number, cz = 0): Ring => ({ c: [sx * 0.095, y, cz], u: X, v: Z, ru: rx * bw, rv: rz * bd, col, w: lw(y) });
    s.tube([lr(0.95, 0.082, 0.092, pants), lr(0.86, 0.088, 0.096, pants), lr(0.72, 0.076, 0.082, pants), lr(0.52, 0.058, 0.062, pants, 0.004), lr(0.38, 0.056, 0.06, pants, -0.008), lr(0.2, 0.044, 0.048, pants, -0.004), lr(0.1, 0.046, 0.05, pants)], 8, true, true);
    // shoe: loft along z
    const sr = (z: number, rx: number, ry: number, cy: number): Ring => ({ c: [sx * 0.095, cy, z], u: X, v: Y, ru: rx, rv: ry, col: shoes, w: [[F, 1]] });
    s.tube([sr(-0.085, 0.036, 0.04, 0.05), sr(-0.04, 0.047, 0.055, 0.056), sr(0.04, 0.05, 0.048, 0.05), sr(0.11, 0.05, 0.036, 0.038), sr(0.165, 0.04, 0.024, 0.026)], 8, true, true);
  }
  if (police) {
    s.box(0, 1.3, 0.125 * bd, 0.07, 0.016, 0.004, 0xe8e8e8, [[B.chest, 1]]);
    s.box(0, 1.0, 0, 0.176 * bw, 0.022, 0.122 * bd, 0x0c0c0e, [[B.hips, 1]]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(s.col, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(s.si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(s.sw, 4));
  g.setIndex(s.idx);
  g.computeVertexNormals();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.4);
  geoCache.set(key, g);
  return g;
}

let sharedMat: THREE.MeshStandardMaterial | null = null;
let gunGeo: THREE.BufferGeometry | null = null;

// ---------------------------------------------------------------- pose
interface Arm { x: number; y: number; z: number; bend: number }
interface Pose {
  hipsX: number; hipsY: number; hipsZ: number;
  pitch: number; roll: number; yaw: number; // hips
  sPitch: number; sYaw: number; sRoll: number; // spine+chest
  hPitch: number; hYaw: number;
  aL: Arm; aR: Arm;
  // foot targets (ankle) in root space + foot pitch
  fLx: number; fLy: number; fLz: number; fLp: number;
  fRx: number; fRy: number; fRz: number; fRp: number;
  /** 1 = feet are planted on the ground (terrain IK applies) */
  planted: number;
}
function newPose(): Pose {
  return { hipsX: 0, hipsY: 0, hipsZ: 0, pitch: 0, roll: 0, yaw: 0, sPitch: 0, sYaw: 0, sRoll: 0, hPitch: 0, hYaw: 0, aL: { x: 0.13, y: -1, z: 0.03, bend: 0.2 }, aR: { x: -0.13, y: -1, z: 0.03, bend: 0.2 }, fLx: 0.1, fLy: ANKLE, fLz: 0, fLp: 0, fRx: -0.1, fRy: ANKLE, fRz: 0, fRp: 0, planted: 1 };
}
const POSE_KEYS = ['hipsX', 'hipsY', 'hipsZ', 'pitch', 'roll', 'yaw', 'sPitch', 'sYaw', 'sRoll', 'hPitch', 'hYaw', 'fLx', 'fLy', 'fLz', 'fLp', 'fRx', 'fRy', 'fRz', 'fRp', 'planted'] as const;
function addPose(out: Pose, p: Pose, w: number): void {
  const o = out as unknown as Record<string, number>, q = p as unknown as Record<string, number>;
  for (const k of POSE_KEYS) o[k] += q[k] * w;
  for (const side of ['aL', 'aR'] as const) {
    out[side].x += p[side].x * w; out[side].y += p[side].y * w; out[side].z += p[side].z * w; out[side].bend += p[side].bend * w;
  }
}
function zeroPose(p: Pose): void {
  const o = p as unknown as Record<string, number>;
  for (const k of POSE_KEYS) o[k] = 0;
  for (const side of ['aL', 'aR'] as const) { p[side].x = p[side].y = p[side].z = p[side].bend = 0; }
}
function setArm(a: Arm, x: number, y: number, z: number, bend: number): void {
  a.x = x; a.y = y; a.z = z; a.bend = bend;
}

export interface CharAnimState {
  speed: number;
  /** movement direction relative to facing (unit, x = left, z = forward) */
  moveX: number;
  moveZ: number;
  grounded: boolean;
  crouch: boolean;
  swim: boolean;
  aim: boolean;
  aimPitch: number;
  vy: number;
  /** 0 normal, 1 knocked, 2 dead, 4 mantle */
  mode: number;
  melee: number; // 0..1 progress, 0 = none
  fired: boolean;
  armed: boolean;
  sprint: boolean;
  /** NPC special states */
  cower?: boolean;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0);

export class CharacterModel {
  readonly group = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  private bones: THREE.Bone[] = [];
  private gun: THREE.Mesh;
  // animation state
  private phase = Math.random();
  private t = Math.random() * 100;
  private wLoco = 0; private wAir = 0; private wSwim = 0; private wKnock = 0; private wCrouch = 0; private wAim = 0; private wMantle = 0; private wCower = 0;
  private landT = 0; private wasGrounded = true; private recoil = 0; private knockDir = 1; private idleVar = 0; private idleT = 5 + Math.random() * 8; private idleKind = 0;
  private speedS = 0; private leanS = 0;
  private poses = { ground: newPose(), air: newPose(), swim: newPose(), knock: newPose(), mantle: newPose(), out: newPose() };
  /** footstep callback: (leftFoot) */
  onStep: ((left: boolean) => void) | null = null;
  private lastStepL = false; private lastStepR = false;
  height = 1.78;

  constructor(appearance: Appearance, police = false) {
    const geo = buildGeometry(appearance, police);
    if (!sharedMat) sharedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 });
    for (let i = 0; i < REST.length; i++) {
      const b = new THREE.Bone();
      const p = PARENT[i];
      if (p >= 0) {
        b.position.set(REST[i][0] - REST[p][0], REST[i][1] - REST[p][1], REST[i][2] - REST[p][2]);
        this.bones[p].add(b);
      } else b.position.set(REST[i][0], REST[i][1], REST[i][2]);
      this.bones.push(b);
    }
    const inverses = REST.map((r) => new THREE.Matrix4().makeTranslation(-r[0], -r[1], -r[2]));
    const skeleton = new THREE.Skeleton(this.bones, inverses);
    this.mesh = new THREE.SkinnedMesh(geo, sharedMat);
    this.mesh.add(this.bones[0]);
    this.mesh.bind(skeleton, new THREE.Matrix4());
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    if (!gunGeo) {
      const g1 = new THREE.BoxGeometry(0.035, 0.05, 0.19);
      g1.translate(0, 0.02, 0.07);
      gunGeo = g1;
    }
    this.gun = new THREE.Mesh(gunGeo, new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.45, metalness: 0.7 }));
    // the hand bone's local +x points along the fingers for the left hand, -x for the right hand
    this.gun.position.set(-0.1, -0.02, 0);
    this.gun.rotation.set(0, -Math.PI / 2, 0);
    this.gun.visible = false;
    this.bones[B.handR].add(this.gun);
  }

  /** World position of the head (camera target, name tags). */
  headWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.bones[B.head].getWorldPosition(out);
  }
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.gun.localToWorld(out.set(0, 0.03, 0.18));
  }

  // -------------------------------------------------------------- pose generators
  private ground(p: Pose, s: CharAnimState, dt: number): void {
    const v = this.speedS;
    const cr = this.wCrouch;
    const moving = clamp01(v / 0.6);
    // gait parameters
    const stride = v < 1.8 ? lerp(0.9, 1.45, v / 1.8) : v < 3.8 ? lerp(1.45, 2.35, (v - 1.8) / 2) : lerp(2.35, 3.7, clamp01((v - 3.8) / 2.9));
    const strideC = lerp(stride, Math.min(stride, 1.0), cr);
    const run = smoothstep(2.2, 3.6, v), sprint = smoothstep(4.6, 6.4, v);
    if (v > 0.05) this.phase = (this.phase + (v / strideC) * dt) % 1;
    const duty = Math.min(0.6, 0.84 / strideC);
    const a = (duty * strideC) / 2;
    const lift = lerp(0.07, 0.19, run) + 0.16 * sprint;
    const foot = (ph: number, out: { z: number; y: number; pitch: number; stance: boolean }) => {
      ph = ph % 1;
      if (ph < duty) {
        // stance: heel rocker → flat foot travelling exactly at ground speed → toe rocker with heel lift
        const u = ph / duty;
        out.z = u < 0.15 ? lerp(0.8 * a, 0.593 * a, u / 0.15) : u < 0.7 ? lerp(0.593 * a, -0.507 * a, (u - 0.15) / 0.55) : lerp(-0.507 * a, -0.92 * a, (u - 0.7) / 0.3);
        out.y = 0.03 * (1 - smoothstep(0, 0.15, u)) + 0.11 * smoothstep(0.62, 1, u);
        out.pitch = -0.25 * (1 - smoothstep(0, 0.18, u)) + 0.6 * smoothstep(0.6, 1, u);
        out.stance = true;
      } else {
        const u = (ph - duty) / (1 - duty);
        const e = u * u * (3 - 2 * u);
        out.z = lerp(-0.92 * a, 0.8 * a, e);
        out.y = lerp(0.11, 0.03, e) + lift * Math.sin(Math.PI * u) * (1 + 0.7 * run * (1 - u));
        out.pitch = lerp(0.6 + run * 0.5, -0.25, e);
        out.stance = false;
      }
    };
    const fl = _fl, fr = _fr;
    foot(this.phase, fl);
    foot(this.phase + 0.5, fr);
    if (this.onStep && moving > 0.5) {
      if (fl.stance && !this.lastStepL) this.onStep(true);
      if (fr.stance && !this.lastStepR) this.onStep(false);
    }
    this.lastStepL = fl.stance;
    this.lastStepR = fr.stance;
    // direction of travel relative to facing (strafe / back-pedal)
    const mx = s.moveX, mz = s.moveZ;
    const width = lerp(0.1, 0.085, run) + cr * 0.04;
    p.fLx = width + mx * fl.z * moving; p.fLz = mz * fl.z * moving + 0.01; p.fLy = ANKLE + fl.y * moving; p.fLp = fl.pitch * moving * (mz >= -0.3 ? 1 : -0.4);
    p.fRx = -width + mx * fr.z * moving; p.fRz = mz * fr.z * moving - 0.01; p.fRy = ANKLE + fr.y * moving; p.fRp = fr.pitch * moving * (mz >= -0.3 ? 1 : -0.4);
    p.planted = 1;
    // hips
    const two = this.phase * Math.PI * 4;
    const bob = (lerp(-0.018 * Math.cos(two), -0.045 * Math.cos(two - duty * Math.PI * 2), run)) * moving;
    const breath = Math.sin(this.t * 1.6);
    p.hipsY = bob - cr * 0.33 - 0.012 - sprint * 0.02 + (1 - moving) * breath * 0.003;
    const sw = Math.sin(this.phase * Math.PI * 2);
    p.hipsX = (-sw * lerp(0.022, 0.012, run) * moving) + (1 - moving) * Math.sin(this.t * 0.35) * 0.012;
    p.hipsZ = cr * -0.04;
    p.yaw = sw * lerp(0.07, 0.16, run) * moving * mz;
    p.roll = -sw * 0.035 * moving;
    p.pitch = (0.02 + v * 0.018 + sprint * 0.06) * Math.max(0, mz) + cr * 0.32 + this.leanS;
    p.sPitch = (0.02 + run * 0.06) * Math.max(0, mz) + cr * 0.22 + (1 - moving) * breath * 0.008;
    p.sYaw = -p.yaw * 1.5;
    p.sRoll = -p.roll * 0.6;
    p.hPitch = -p.pitch * 0.55 - cr * 0.3;
    p.hYaw = 0;
    // arms
    const arm = lerp(0.36, 0.72, run) + sprint * 0.3;
    const bend = lerp(0.22, 1.35, run) + sprint * 0.2 + cr * 0.6;
    const sl = -sw * arm * moving * mz, sr = sw * arm * moving * mz;
    setArm(p.aL, 0.14 + run * 0.05, -Math.cos(sl), Math.sin(sl) + 0.03 + cr * 0.3, bend + Math.max(0, sl) * 0.5 * run);
    setArm(p.aR, -0.14 - run * 0.05, -Math.cos(sr), Math.sin(sr) + 0.03 + cr * 0.3, bend + Math.max(0, sr) * 0.5 * run);
    // idle fidgets
    if (moving < 0.2 && cr < 0.3 && this.wAim < 0.2) {
      this.idleT -= dt;
      if (this.idleT <= 0) { this.idleT = 9 + Math.random() * 12; this.idleVar = 3.4; this.idleKind = Math.floor(Math.random() * 3); }
    } else this.idleVar = Math.min(this.idleVar, 0.3);
    if (this.idleVar > 0) {
      this.idleVar -= dt;
      const k = smoothstep(0, 0.5, this.idleVar) * smoothstep(3.4, 2.9, this.idleVar);
      if (this.idleKind === 0) { // glance at the wrist watch
        setArm(p.aL, lerp(p.aL.x, -0.1, k), lerp(p.aL.y, -0.35, k), lerp(p.aL.z, 0.7, k), lerp(p.aL.bend, 1.75, k));
        p.hPitch += 0.35 * k; p.hYaw += 0.2 * k;
      } else if (this.idleKind === 1) { // look around
        p.hYaw += Math.sin(this.idleVar * 2.2) * 0.75 * k; p.sYaw += Math.sin(this.idleVar * 2.2) * 0.2 * k;
      } else { // hands on hips, shift weight
        setArm(p.aL, lerp(p.aL.x, 0.5, k), p.aL.y, lerp(p.aL.z, -0.15, k), lerp(p.aL.bend, 1.5, k));
        setArm(p.aR, lerp(p.aR.x, -0.5, k), p.aR.y, lerp(p.aR.z, -0.15, k), lerp(p.aR.bend, 1.5, k));
        p.hipsX += 0.025 * k; p.roll += 0.04 * k;
      }
    }
    if (this.landT > 0) {
      const k = Math.sin(clamp01(this.landT / 0.28) * Math.PI) * 0.16;
      p.hipsY -= k; p.pitch += k * 0.6;
    }
  }
  private air(p: Pose, s: CharAnimState): void {
    const fall = clamp01(-s.vy / 9), rise = clamp01(s.vy / 6);
    const fl = Math.sin(this.t * 11) * fall;
    p.hipsX = 0; p.hipsY = 0.02; p.hipsZ = 0;
    p.pitch = 0.1 - rise * 0.12 + fall * 0.08; p.roll = 0; p.yaw = 0;
    p.sPitch = 0.08; p.sYaw = 0; p.sRoll = 0; p.hPitch = -0.1; p.hYaw = 0;
    setArm(p.aL, 0.7 + fl * 0.1, -0.25 + rise * 0.5 + fall * 0.35, 0.3, 0.6);
    setArm(p.aR, -0.7 + fl * 0.1, -0.25 + rise * 0.5 + fall * 0.35 - fl * 0.2, 0.2, 0.7);
    // tucked legs, reaching for the ground while falling
    p.fLx = 0.1; p.fLy = HIP_Y - lerp(0.6, 0.78, fall) + 0.02; p.fLz = 0.16 - fall * 0.1; p.fLp = 0.35;
    p.fRx = -0.1; p.fRy = HIP_Y - lerp(0.7, 0.8, fall) + 0.02; p.fRz = -0.1 + fall * 0.08; p.fRp = 0.5;
    p.planted = 0;
  }
  private swim(p: Pose, s: CharAnimState): void {
    const mv = clamp01(this.speedS / 1.0);
    const ph = this.t * (1.1 + mv * 0.9);
    const u = (ph % 1 + 1) % 1;
    // tread (upright) ↔ breaststroke (prone)
    const prone = mv;
    p.hipsX = 0; p.hipsY = lerp(0.02 + Math.sin(this.t * 2.2) * 0.02, 0.26, prone); p.hipsZ = lerp(0, -0.35, prone);
    p.pitch = lerp(0.12, 1.22, prone); p.roll = Math.sin(this.t * 1.3) * 0.03; p.yaw = 0;
    p.sPitch = lerp(0, -0.12, prone); p.sYaw = 0; p.sRoll = 0;
    p.hPitch = lerp(-0.1, -0.85, prone); p.hYaw = 0;
    // arms: in chest space +y is "ahead" when prone
    const pull = Math.sin(u * Math.PI);
    const ax = lerp(0.75 + Math.sin(this.t * 2.5) * 0.15, 0.12 + pull * 0.85, prone), ay = lerp(-0.12, Math.cos(u * Math.PI * 0.95), prone), az = lerp(0.45 + Math.cos(this.t * 2.5) * 0.2, 0.25, prone);
    setArm(p.aL, ax, ay, az, lerp(0.5, u > 0.6 ? 1.3 : 0.25, prone));
    setArm(p.aR, -ax, ay, az, lerp(0.5, u > 0.6 ? 1.3 : 0.25, prone));
    // legs in hips space (converted to root space by the solver via planted = 0)
    const k = Math.sin(ph * Math.PI * 2);
    p.fLx = 0.12 + Math.max(0, k) * 0.12 * prone; p.fLy = HIP_Y - 0.74 + Math.max(0, k) * 0.18; p.fLz = lerp(Math.sin(this.t * 3) * 0.16, -0.05, prone); p.fLp = 0.9;
    p.fRx = -0.12 - Math.max(0, k) * 0.12 * prone; p.fRy = HIP_Y - 0.74 + Math.max(0, lerp(-k, k, prone)) * 0.18; p.fRz = lerp(-Math.sin(this.t * 3) * 0.16, -0.05, prone); p.fRp = 0.9;
    p.planted = 0;
    void s;
  }
  private knock(p: Pose, s: CharAnimState): void {
    const flail = clamp01(this.speedS / 3 + Math.abs(s.vy) / 6);
    const n1 = Math.sin(this.t * 13) * flail, n2 = Math.cos(this.t * 9.3) * flail;
    const d = this.knockDir;
    p.hipsX = 0; p.hipsY = -0.74; p.hipsZ = 0;
    p.pitch = d * -1.42 + n1 * 0.12; p.roll = n2 * 0.2 + 0.08; p.yaw = 0.15;
    p.sPitch = d * 0.1; p.sYaw = 0.12; p.sRoll = 0.06; p.hPitch = d * -0.15; p.hYaw = 0.5;
    setArm(p.aL, 0.9, 0.25 + n1 * 0.5, 0.15 * d + n2 * 0.4, 0.5 + flail * 0.5);
    setArm(p.aR, -0.8, -0.35 + n2 * 0.5, 0.2 * d + n1 * 0.4, 0.9);
    p.fLx = 0.2; p.fLy = HIP_Y - 0.8; p.fLz = 0.08 + n1 * 0.2; p.fLp = 0.6;
    p.fRx = -0.16; p.fRy = HIP_Y - 0.7 + n2 * 0.1; p.fRz = -0.12 + n2 * 0.2; p.fRp = 0.4;
    p.planted = 0;
  }
  private mantle(p: Pose): void {
    p.hipsX = 0; p.hipsY = -0.05; p.hipsZ = -0.05;
    p.pitch = 0.25; p.roll = 0; p.yaw = 0; p.sPitch = 0.2; p.sYaw = 0; p.sRoll = 0; p.hPitch = -0.3; p.hYaw = 0;
    setArm(p.aL, 0.25, 0.75, 0.6, 0.9);
    setArm(p.aR, -0.25, 0.75, 0.6, 0.9);
    p.fLx = 0.1; p.fLy = HIP_Y - 0.62; p.fLz = 0.2; p.fLp = 0.3;
    p.fRx = -0.1; p.fRy = HIP_Y - 0.8; p.fRz = -0.05; p.fRp = 0.5;
    p.planted = 0;
  }

  // -------------------------------------------------------------- update
  /**
   * @param ground optional terrain query (world x,z → height) for foot placement
   */
  update(dt: number, s: CharAnimState, x: number, y: number, z: number, yaw: number, ground?: (x: number, z: number) => number): void {
    this.t += dt;
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    const k = (r: number) => 1 - Math.exp(-r * dt);
    const knocked = s.mode === 1 || s.mode === 2;
    if (knocked && this.wKnock < 0.05) this.knockDir = s.moveZ < -0.2 ? -1 : 1;
    const tKnock = knocked ? 1 : 0, tSwim = !knocked && s.swim ? 1 : 0, tMantle = !knocked && s.mode === 4 ? 1 : 0;
    const tAir = !knocked && !s.swim && !s.grounded && s.mode !== 4 ? 1 : 0;
    this.wKnock += (tKnock - this.wKnock) * k(knocked ? 9 : 3.2);
    this.wSwim += (tSwim - this.wSwim) * k(6);
    this.wMantle += (tMantle - this.wMantle) * k(10);
    this.wAir += (tAir - this.wAir) * k(tAir ? 9 : 14);
    this.wCrouch += ((s.crouch ? 1 : 0) - this.wCrouch) * k(9);
    this.wCower += ((s.cower ? 1 : 0) - this.wCower) * k(6);
    this.wAim += ((s.aim && !knocked && !s.swim ? 1 : 0) - this.wAim) * k(13);
    this.speedS += (s.speed - this.speedS) * k(12);
    if (s.grounded && !this.wasGrounded && s.vy <= 0) this.landT = 0.28;
    this.wasGrounded = s.grounded;
    if (this.landT > 0) this.landT -= dt;
    if (s.fired) this.recoil = 1;
    this.recoil *= Math.exp(-dt * 16);
    this.gun.visible = s.armed && this.wAim > 0.3;

    const P = this.poses;
    this.ground(P.ground, s, dt);
    const out = P.out;
    zeroPose(out);
    let wG = 1;
    if (this.wKnock > 0.001) { this.knock(P.knock, s); addPose(out, P.knock, this.wKnock); wG -= this.wKnock; }
    if (this.wSwim > 0.001) { this.swim(P.swim, s); const w = this.wSwim * wG; addPose(out, P.swim, w); wG -= w; }
    if (this.wMantle > 0.001) { this.mantle(P.mantle); const w = this.wMantle * wG; addPose(out, P.mantle, w); wG -= w; }
    if (this.wAir > 0.001) { this.air(P.air, s); const w = this.wAir * wG; addPose(out, P.air, w); wG -= w; }
    addPose(out, P.ground, Math.max(0, wG));
    if (this.wCower > 0.01) {
      const c = this.wCower;
      out.hipsY -= 0.42 * c; out.pitch += 0.5 * c; out.sPitch += 0.4 * c; out.hPitch += 0.3 * c;
      setArm(out.aL, lerp(out.aL.x, 0.2, c), lerp(out.aL.y, 0.6, c), lerp(out.aL.z, 0.5, c), lerp(out.aL.bend, 2.2, c));
      setArm(out.aR, lerp(out.aR.x, -0.2, c), lerp(out.aR.y, 0.6, c), lerp(out.aR.z, 0.5, c), lerp(out.aR.bend, 2.2, c));
    }
    // --- upper body overlays
    if (this.wAim > 0.01) {
      const a = this.wAim, pt = clamp(s.aimPitch, -1.1, 1.1);
      const cy = Math.sin(pt) + this.recoil * 0.12, cz = Math.cos(pt);
      if (s.armed) {
        setArm(out.aR, lerp(out.aR.x, 0.02, a), lerp(out.aR.y, cy - 0.02, a), lerp(out.aR.z, cz, a), lerp(out.aR.bend, 0.12, a));
        setArm(out.aL, lerp(out.aL.x, -0.22, a), lerp(out.aL.y, cy - 0.08, a), lerp(out.aL.z, cz * 0.92, a), lerp(out.aL.bend, 0.62, a));
      } else {
        // boxing guard
        setArm(out.aR, lerp(out.aR.x, -0.12, a), lerp(out.aR.y, -0.2, a), lerp(out.aR.z, 0.7, a), lerp(out.aR.bend, 2.0, a));
        setArm(out.aL, lerp(out.aL.x, 0.1, a), lerp(out.aL.y, -0.15, a), lerp(out.aL.z, 0.8, a), lerp(out.aL.bend, 1.8, a));
      }
      out.sPitch += (-pt * 0.35) * a;
      out.hPitch += (-pt * 0.3) * a;
      out.sYaw += (s.armed ? -0.18 : 0.25) * a;
    }
    if (s.melee > 0 && s.melee < 1) {
      const m = s.melee;
      const wind = smoothstep(0, 0.25, m) * (1 - smoothstep(0.25, 0.42, m)), hit = smoothstep(0.25, 0.42, m) * (1 - smoothstep(0.6, 1, m));
      const w = Math.max(wind, hit);
      setArm(out.aR, lerp(out.aR.x, lerp(-0.35, 0.05, hit), w), lerp(out.aR.y, lerp(-0.25, 0.08, hit), w), lerp(out.aR.z, lerp(-0.25, 1, hit), w), lerp(out.aR.bend, lerp(2.0, 0.1, hit), w));
      setArm(out.aL, lerp(out.aL.x, 0.15, w), lerp(out.aL.y, -0.2, w), lerp(out.aL.z, 0.7, w), lerp(out.aL.bend, 1.9, w));
      out.sYaw += wind * -0.5 + hit * 0.55;
      out.pitch += hit * 0.12;
      out.hipsZ += hit * 0.06;
    }
    this.apply(out, x, y, z, yaw, ground);
  }

  private apply(p: Pose, wx: number, wy: number, wz: number, yaw: number, ground?: (x: number, z: number) => number): void {
    const b = this.bones;
    const planted = clamp01(p.planted);
    // --- terrain foot placement
    let fLy = p.fLy, fRy = p.fRy, slopeP = 0;
    let hipsDrop = 0;
    if (ground && planted > 0.5) {
      const s = Math.sin(yaw), c = Math.cos(yaw);
      const gl = ground(wx + c * p.fLx + s * p.fLz, wz - s * p.fLx + c * p.fLz) - wy;
      const gr = ground(wx + c * p.fRx + s * p.fRz, wz - s * p.fRx + c * p.fRz) - wy;
      const dl = clamp(gl, -0.4, 0.4), dr = clamp(gr, -0.4, 0.4);
      fLy += dl * planted; fRy += dr * planted;
      hipsDrop = Math.min(0, Math.min(dl, dr)) * 0.75 + Math.max(0, Math.max(dl, dr) - 0.2) * 0.2;
      const gf = ground(wx + s * 0.25, wz + c * 0.25), gb = ground(wx - s * 0.25, wz - c * 0.25);
      slopeP = clamp(Math.atan2(gf - gb, 0.5), -0.5, 0.5);
    }
    // --- hips
    const hips = b[B.hips];
    hips.position.set(REST[0][0] + p.hipsX, REST[0][1] + p.hipsY + hipsDrop, REST[0][2] + p.hipsZ);
    hips.quaternion.setFromEuler(_e.set(p.pitch, p.yaw, p.roll, 'YXZ'));
    b[B.spine].quaternion.setFromEuler(_e.set(p.sPitch * 0.5, p.sYaw * 0.4, p.sRoll * 0.5, 'YXZ'));
    b[B.chest].quaternion.setFromEuler(_e.set(p.sPitch * 0.5, p.sYaw * 0.6, p.sRoll * 0.5, 'YXZ'));
    b[B.neck].quaternion.setFromEuler(_e.set(p.hPitch * 0.4, p.hYaw * 0.4, 0, 'YXZ'));
    b[B.head].quaternion.setFromEuler(_e.set(p.hPitch * 0.6, p.hYaw * 0.6, 0, 'YXZ'));
    // --- arms: aim the upper arm along a direction (chest space), bend the elbow
    const arm = (a: Arm, upper: number, fore: number, hand: number, sx: number) => {
      const l = Math.hypot(a.x, a.y, a.z) || 1;
      _v1.set(a.x / l, a.y / l, a.z / l);
      b[upper].quaternion.setFromUnitVectors(_v2.set(sx, 0, 0), _v1);
      b[fore].quaternion.setFromAxisAngle(AY, -sx * clamp(a.bend, 0, 2.5));
      b[hand].quaternion.identity();
    };
    arm(p.aL, B.uArmL, B.fArmL, B.handL, 1);
    arm(p.aR, B.uArmR, B.fArmR, B.handR, -1);
    // --- legs: two-bone IK towards the ankle targets (root space)
    const hq = hips.quaternion;
    if (planted > 0.5) {
      // lower the pelvis just enough for the far foot to reach its target
      let over = 0;
      for (const sx of [1, -1]) {
        _v1.set(sx * 0.095, HIP_Y - 0.95, 0).applyQuaternion(hq).add(hips.position);
        const tx = sx > 0 ? p.fLx : p.fRx, ty = sx > 0 ? fLy : fRy, tz = sx > 0 ? p.fLz : p.fRz;
        const D = Math.hypot(tx - _v1.x, ty - _v1.y, tz - _v1.z);
        over = Math.max(over, D - (L1 + L2 - 0.006));
      }
      if (over > 0) hips.position.y -= Math.min(0.1, over * 1.25);
    }
    const leg = (sx: number, tx: number, ty: number, tz: number, footPitch: number, thigh: number, shin: number, foot: number) => {
      // hip joint in root space
      _v1.set(sx * 0.095, HIP_Y - 0.95, 0).applyQuaternion(hq).add(hips.position);
      // targets given in hips space when not planted
      if (planted < 0.999) {
        _v3.set(tx, ty - 0.95 + 0.0, tz).applyQuaternion(hq).add(hips.position);
        _v2.set(tx, ty, tz).lerp(_v3, 1 - planted);
      } else _v2.set(tx, ty, tz);
      const d = _v3.copy(_v2).sub(_v1);
      let D = d.length();
      const maxD = L1 + L2 - 0.004;
      if (D > maxD) { d.multiplyScalar(maxD / D); D = maxD; }
      if (D < 0.2) { d.set(0, -0.2, 0.01); D = d.length(); }
      const dn = _v2.copy(d).multiplyScalar(1 / D);
      // pole: forward in hips space (knees point ahead), slightly outward
      const pole = _v4.set(sx * 0.12, 0, 1).applyQuaternion(hq);
      // component of the pole perpendicular to the leg direction
      const n = pole.addScaledVector(dn, -pole.dot(dn)).normalize();
      const cosA = clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1);
      const sinA = Math.sqrt(1 - cosA * cosA);
      // thigh direction
      const tdx = dn.x * cosA + n.x * sinA, tdy = dn.y * cosA + n.y * sinA, tdz = dn.z * cosA + n.z * sinA;
      // hinge axis h = n × dn
      const hx = n.y * dn.z - n.z * dn.y, hy = n.z * dn.x - n.x * dn.z, hz = n.x * dn.y - n.y * dn.x;
      // basis: X = h, Y = -t, Z = X × Y
      const zx = hy * -tdz - hz * -tdy, zy = hz * -tdx - hx * -tdz, zz = hx * -tdy - hy * -tdx;
      _m.set(hx, -tdx, zx, 0, hy, -tdy, zy, 0, hz, -tdz, zz, 0, 0, 0, 0, 1);
      _q.setFromRotationMatrix(_m); // thigh orientation in root space
      b[thigh].quaternion.copy(_q2.copy(hq).invert()).multiply(_q);
      const interior = Math.acos(clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1));
      const bend = Math.PI - interior;
      b[shin].quaternion.setFromAxisAngle(AX, bend);
      // foot: keep it flat (plus gait pitch and terrain slope) in root space
      _q3.setFromAxisAngle(AX, bend);
      _q.multiply(_q3); // shin orientation in root space
      _q2.setFromEuler(_e.set(footPitch * (planted > 0.5 ? 1 : 0.6) - slopeP * planted + (1 - planted) * p.pitch * 0.5, 0, 0, 'YXZ'));
      b[foot].quaternion.copy(_q.invert()).multiply(_q2);
    };
    leg(1, p.fLx, fLy + hipsDrop * (1 - planted), p.fLz, p.fLp, B.thighL, B.shinL, B.footL);
    leg(-1, p.fRx, fRy + hipsDrop * (1 - planted), p.fRz, p.fRp, B.thighR, B.shinR, B.footR);
  }
}
const _fl = { z: 0, y: 0, pitch: 0, stance: true }, _fr = { z: 0, y: 0, pitch: 0, stance: true };
