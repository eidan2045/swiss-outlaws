// Instanced scenery: trees (two LODs), street lamps with night glow, traffic signals.
import * as THREE from 'three';
import { Rng, clamp, hash2 } from '../../shared/math';
import { World } from '../../shared/world/world';
import { WORLD_HALF } from '../../shared/world/layout';
import { TreeSpec } from '../../shared/world/city';
import { signalColor } from '../../shared/world/signals';
import { MeshBuilder } from './meshbuilder';
import { Quality, U, patchMaterial, replaceOnce } from './globals';

const CELL = 96;
const CELLS = (WORLD_HALF * 2) / CELL;

// ---------------------------------------------------------------- tree geometry
function ring(B: MeshBuilder, y0: number, r0: number, y1: number, r1: number, sides: number, c0: number[], c1: number[], jitter: number, rng: Rng, droop = 0): void {
  const pts0: number[][] = [], pts1: number[][] = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const j0 = i === sides ? pts0[0][3] : 1 + (rng.next() - 0.5) * jitter, j1 = i === sides ? (pts1[0] ? pts1[0][3] : 1) : 1 + (rng.next() - 0.5) * jitter;
    pts0.push([Math.cos(a) * r0 * j0, y0 - droop * j0, Math.sin(a) * r0 * j0, j0]);
    pts1.push([Math.cos(a) * r1 * j1, y1, Math.sin(a) * r1 * j1, j1]);
  }
  const slope = (r0 - r1) / Math.max(0.01, y1 - y0);
  for (let i = 0; i < sides; i++) {
    const a = pts0[i], b = pts0[i + 1], c = pts1[i + 1], d = pts1[i];
    const n = (p: number[]) => {
      const l = Math.hypot(p[0], p[2]) || 1;
      const nx = p[0] / l, nz = p[2] / l, ny = slope;
      const ll = Math.hypot(nx, ny, nz);
      return [nx / ll, ny / ll, nz / ll];
    };
    const na = n(a), nb = n(b), nc = r1 > 0.01 ? n(c) : nb, nd = r1 > 0.01 ? n(d) : na;
    B.color(c0[0], c0[1], c0[2]);
    // winding: counter-clockwise seen from outside (a → b goes with increasing angle = clockwise from above, so flip)
    const i0 = B.vert(b[0], b[1], b[2], nb[0], nb[1], nb[2], 0, 0);
    B.vert(a[0], a[1], a[2], na[0], na[1], na[2], 1, 0);
    B.color(c1[0], c1[1], c1[2]);
    B.vert(d[0], d[1], d[2], nd[0], nd[1], nd[2], 1, 1);
    B.vert(c[0], c[1], c[2], nc[0], nc[1], nc[2], 0, 1);
    B.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  }
}
function blob(B: MeshBuilder, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, dark: number[], light: number[], rng: Rng, detail: number): void {
  const lat = detail, lon = detail + 2;
  const P: number[][][] = [];
  for (let i = 0; i <= lat; i++) {
    const row: number[][] = [];
    const v = i / lat, phi = v * Math.PI;
    for (let j = 0; j <= lon; j++) {
      const th = (j / lon) * Math.PI * 2;
      const jit = j === lon ? row[0][6] : 1 + (rng.next() - 0.5) * 0.3;
      const nx = Math.sin(phi) * Math.cos(th), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(th);
      row.push([cx + nx * rx * jit, cy + ny * ry * jit, cz + nz * rz * jit, nx, ny, nz, jit]);
    }
    P.push(row);
  }
  for (let i = 0; i < lat; i++)
    for (let j = 0; j < lon; j++) {
      const a = P[i][j], b = P[i][j + 1], c = P[i + 1][j + 1], d = P[i + 1][j];
      const col = (p: number[]) => {
        const t = clamp(p[4] * 0.5 + 0.5, 0, 1);
        B.color(dark[0] + (light[0] - dark[0]) * t, dark[1] + (light[1] - dark[1]) * t, dark[2] + (light[2] - dark[2]) * t);
      };
      col(a); const i0 = B.vert(a[0], a[1], a[2], a[3], a[4], a[5], 0, 0);
      col(b); B.vert(b[0], b[1], b[2], b[3], b[4], b[5], 1, 0);
      col(c); B.vert(c[0], c[1], c[2], c[3], c[4], c[5], 1, 1);
      col(d); B.vert(d[0], d[1], d[2], d[3], d[4], d[5], 0, 1);
      B.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }
}
function toGeo(B: MeshBuilder): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(B.pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(B.nor), 3));
  const c = new Float32Array(B.count * 3);
  for (let i = 0; i < B.count; i++) { c[i * 3] = B.col[i * 4]; c[i * 3 + 1] = B.col[i * 4 + 1]; c[i * 3 + 2] = B.col[i * 4 + 2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setIndex(B.idx);
  g.computeBoundingSphere();
  return g;
}
const BARK = [0.16, 0.115, 0.08], BARK2 = [0.2, 0.15, 0.1];

function conifer(lod: number, seed: number): THREE.BufferGeometry {
  const B = new MeshBuilder(), rng = new Rng(seed);
  const H = 15;
  if (lod === 0) {
    ring(B, 0, 0.36, 4, 0.22, 6, BARK, BARK2, 0.1, rng);
    const layers = 7;
    for (let i = 0; i < layers; i++) {
      const t = i / (layers - 1);
      const y0 = 2.2 + t * (H - 5.2), r0 = 3.5 * (1 - t * 0.78), y1 = y0 + 3.6 - t * 1.2;
      const dk = [0.035, 0.085 + t * 0.02, 0.04], lt = [0.075, 0.17 + t * 0.03, 0.065];
      ring(B, y0, r0, y1, r0 * 0.16, 9, dk, lt, 0.34, rng, 0.75);
    }
  } else {
    ring(B, 2.0, 3.2, 9, 1.3, 6, [0.04, 0.09, 0.042], [0.06, 0.13, 0.055], 0.2, rng, 0.4);
    ring(B, 8.4, 1.9, H, 0, 6, [0.05, 0.11, 0.05], [0.075, 0.16, 0.065], 0.2, rng, 0.3);
  }
  return toGeo(B);
}
function deciduous(lod: number, seed: number, street: boolean): THREE.BufferGeometry {
  const B = new MeshBuilder(), rng = new Rng(seed);
  const dark = street ? [0.07, 0.15, 0.045] : [0.06, 0.13, 0.04], light = street ? [0.2, 0.33, 0.09] : [0.17, 0.3, 0.08];
  const trunkH = street ? 3.6 : 3.0;
  if (lod === 0) {
    ring(B, 0, 0.34, trunkH, 0.24, 7, BARK, BARK2, 0.12, rng);
    ring(B, trunkH, 0.24, trunkH + 2.4, 0.1, 6, BARK2, BARK2, 0.1, rng);
    const n = street ? 5 : 7;
    const R = street ? 2.5 : 3.3;
    blob(B, 0, trunkH + R * 0.95, 0, R * 0.9, R * 0.85, R * 0.9, dark, light, rng, 5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.next() * 0.6, d = R * (0.55 + rng.next() * 0.3);
      const r = R * (0.5 + rng.next() * 0.25);
      blob(B, Math.cos(a) * d, trunkH + R * (0.55 + rng.next() * 0.75), Math.sin(a) * d, r, r * 0.82, r, dark, light, rng, 4);
    }
  } else {
    const R = street ? 2.9 : 3.9;
    ring(B, 0, 0.3, trunkH + 0.5, 0.2, 4, BARK, BARK2, 0, rng);
    blob(B, 0, trunkH + R * 0.85, 0, R, R * 0.86, R, dark, light, rng, 3);
  }
  return toGeo(B);
}

// ---------------------------------------------------------------- scenery
interface TreeCell { near: THREE.InstancedMesh[]; far: THREE.InstancedMesh[]; cx: number; cz: number; maxY: number; minY: number }

export class Scenery {
  readonly group = new THREE.Group();
  private cells: TreeCell[] = [];
  private bulbMat: THREE.MeshBasicMaterial;
  private poolMat: THREE.MeshBasicMaterial;
  private sigMeshes: THREE.InstancedMesh[] = [];
  private sigTimer = 0;
  private treeMat: THREE.MeshStandardMaterial;

  constructor(private world: World, private quality: Quality) {
    // ---- trees
    this.treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
    patchMaterial(this.treeMat, 'tree', (sh) => {
      sh.uniforms.uTime = U.uTime;
      sh.uniforms.uWind = U.uWind;
      sh.uniforms.uSnow = U.uSnow;
      sh.vertexShader = replaceOnce(sh.vertexShader, '#include <common>', '#include <common>\nuniform float uTime; uniform vec3 uWind;\nvarying float vH;');
      sh.vertexShader = replaceOnce(sh.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>
{
  float h = max(0.0, position.y - 2.0);
  vH = position.y;
  #ifdef USE_INSTANCING
    vec2 ph = instanceMatrix[3].xz * 0.21;
  #else
    vec2 ph = vec2(0.0);
  #endif
  float sway = sin(uTime * 1.25 + ph.x + ph.y) * 0.6 + sin(uTime * 2.9 + ph.x * 1.7 + position.x) * 0.25;
  transformed.xz += uWind.xz * sway * h * h * 0.0016;
}`);
      sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <common>', '#include <common>\nuniform float uSnow;\nvarying float vH;');
      sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.88, 0.93), uSnow * 0.7 * smoothstep(3.0, 5.0, vH));`);
    });
    const geos = [
      [conifer(0, 11), conifer(1, 12)],
      [deciduous(0, 21, false), deciduous(1, 22, false)],
      [deciduous(0, 31, true), deciduous(1, 32, true)],
    ];
    const buckets: TreeSpec[][][] = [];
    for (let i = 0; i < CELLS * CELLS; i++) buckets.push([[], [], []]);
    for (const t of world.city.trees) {
      const cx = clamp(Math.floor((t.x + WORLD_HALF) / CELL), 0, CELLS - 1), cz = clamp(Math.floor((t.z + WORLD_HALF) / CELL), 0, CELLS - 1);
      buckets[cz * CELLS + cx][t.type].push(t);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    buckets.forEach((byType, i) => {
      const cell: TreeCell = { near: [], far: [], cx: ((i % CELLS) + 0.5) * CELL - WORLD_HALF, cz: (Math.floor(i / CELLS) + 0.5) * CELL - WORLD_HALF, maxY: -1e9, minY: 1e9 };
      byType.forEach((list, type) => {
        if (!list.length) return;
        for (let lod = 0; lod < 2; lod++) {
          const im = new THREE.InstancedMesh(geos[type][lod], this.treeMat, list.length);
          list.forEach((t, k) => {
            const r = hash2(Math.round(t.x * 3), Math.round(t.z * 3), 77);
            q.setFromAxisAngle(up, r * Math.PI * 2);
            const sc = t.s * (type === 0 ? 1.0 : 0.95);
            s.set(sc * (0.9 + r * 0.2), sc, sc * (0.9 + r * 0.2));
            p.set(t.x, t.y, t.z);
            m.compose(p, q, s);
            im.setMatrixAt(k, m);
            const v = 0.82 + hash2(Math.round(t.x), Math.round(t.z), 78) * 0.36;
            col.setRGB(v * (type === 0 ? 1 : 0.9 + r * 0.25), v, v * 0.95);
            im.setColorAt(k, col);
            cell.maxY = Math.max(cell.maxY, t.y + 20);
            cell.minY = Math.min(cell.minY, t.y);
          });
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          im.castShadow = lod === 0;
          im.receiveShadow = lod === 0;
          im.matrixAutoUpdate = false;
          im.visible = false;
          this.group.add(im);
          (lod === 0 ? cell.near : cell.far).push(im);
        }
      });
      if (cell.near.length) this.cells.push(cell);
    });

    // ---- lamps
    const lamps = world.city.lamps;
    const poleGeo = this.lampGeometry();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55, metalness: 0.7 });
    this.bulbMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false });
    this.poolMat = new THREE.MeshBasicMaterial({ map: this.poolTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffc98a, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: false });
    const bulbGeo = new THREE.BoxGeometry(0.34, 0.07, 0.7);
    const poolGeo = new THREE.PlaneGeometry(1, 1);
    poolGeo.rotateX(-Math.PI / 2);
    const byCell = new Map<number, number[]>();
    lamps.forEach((l, i) => {
      const cx = clamp(Math.floor((l.x + WORLD_HALF) / 192), 0, 15), cz = clamp(Math.floor((l.z + WORLD_HALF) / 192), 0, 15);
      const k = cz * 16 + cx;
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k)!.push(i);
    });
    for (const [, ids] of byCell) {
      const poles = new THREE.InstancedMesh(poleGeo, poleMat, ids.length);
      const bulbs = new THREE.InstancedMesh(bulbGeo, this.bulbMat, ids.length);
      const pools = new THREE.InstancedMesh(poolGeo, this.poolMat, ids.length);
      ids.forEach((id, k) => {
        const l = lamps[id];
        const hgt = l.type === 2 ? 1.25 : l.type === 1 ? 0.72 : 1;
        q.setFromAxisAngle(up, l.rot);
        p.set(l.x, l.y, l.z);
        s.set(1, hgt, 1);
        m.compose(p, q, s);
        poles.setMatrixAt(k, m);
        // lamp head sits at the end of the arm (local +z), 7.6 m up
        const ax = Math.sin(l.rot) * 1.5, az = Math.cos(l.rot) * 1.5;
        p.set(l.x + ax, l.y + 7.52 * hgt, l.z + az);
        s.set(1, 1, 1);
        m.compose(p, q, s);
        bulbs.setMatrixAt(k, m);
        p.set(l.x + ax, world.terrainAt(l.x + ax, l.z + az) + 0.12, l.z + az);
        const r = l.type === 2 ? 26 : l.type === 1 ? 13 : 19;
        s.set(r, 1, r);
        m.compose(p, q, s);
        pools.setMatrixAt(k, m);
      });
      for (const im of [poles, bulbs, pools]) {
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.matrixAutoUpdate = false;
        this.group.add(im);
      }
      poles.castShadow = true;
      pools.renderOrder = 3;
      pools.userData.pool = true;
      bulbs.userData.bulb = true;
    }

    // ---- traffic signals
    const sigs = world.city.signals;
    if (sigs.length) {
      const B = new MeshBuilder();
      B.color(0.06, 0.065, 0.07);
      B.box(0, 1.75, 0, 0.07, 1.75, 0.07);
      B.box(0, 3.95, 0.02, 0.19, 0.55, 0.14);
      const body = new THREE.InstancedMesh(B.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 }), sigs.length);
      const lensGeo = new THREE.CircleGeometry(0.105, 12);
      const lensMat = new THREE.MeshBasicMaterial({ toneMapped: false });
      for (let li = 0; li < 3; li++) {
        const im = new THREE.InstancedMesh(lensGeo, lensMat, sigs.length);
        sigs.forEach((sg, k) => {
          q.setFromAxisAngle(up, sg.rot);
          p.set(sg.x + Math.sin(sg.rot) * 0.165, sg.y + 4.3 - li * 0.35, sg.z + Math.cos(sg.rot) * 0.165);
          s.set(1, 1, 1);
          m.compose(p, q, s);
          im.setMatrixAt(k, m);
          im.setColorAt(k, col.setRGB(0.02, 0.02, 0.02));
        });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.matrixAutoUpdate = false;
        im.frustumCulled = false;
        this.group.add(im);
        this.sigMeshes.push(im);
      }
      sigs.forEach((sg, k) => {
        q.setFromAxisAngle(up, sg.rot);
        p.set(sg.x, sg.y, sg.z);
        s.set(1, 1, 1);
        m.compose(p, q, s);
        body.setMatrixAt(k, m);
      });
      body.instanceMatrix.needsUpdate = true;
      body.computeBoundingSphere();
      body.matrixAutoUpdate = false;
      body.frustumCulled = false;
      body.castShadow = true;
      this.group.add(body);
    }
  }

  private lampGeometry(): THREE.BufferGeometry {
    const B = new MeshBuilder();
    B.color(1, 1, 1);
    B.box(0, 3.8, 0, 0.07, 3.8, 0.07);
    B.box(0, 0.2, 0, 0.12, 0.2, 0.12);
    B.box(0, 7.6, 0.75, 0.045, 0.045, 0.8);
    B.box(0, 7.58, 1.5, 0.2, 0.07, 0.4);
    return B.build();
  }
  private poolTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.3)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  setQuality(q: Quality): void {
    this.quality = q;
  }

  update(cam: THREE.Vector3, night: number, simTime: number, dt: number): void {
    const near2 = this.quality.treeNear ** 2, far2 = this.quality.treeFar ** 2;
    for (const c of this.cells) {
      const dx = Math.max(0, Math.abs(cam.x - c.cx) - CELL / 2), dz = Math.max(0, Math.abs(cam.z - c.cz) - CELL / 2);
      const dy = cam.y > c.maxY ? cam.y - c.maxY : 0;
      const d2 = dx * dx + dz * dz + dy * dy;
      const n = d2 < near2, f = !n && d2 < far2;
      for (const im of c.near) im.visible = n;
      for (const im of c.far) im.visible = f;
    }
    // lamps
    const on = night > 0.25;
    this.bulbMat.color.setRGB(on ? 3.2 : 0.5, on ? 2.5 : 0.5, on ? 1.5 : 0.48);
    this.poolMat.opacity = Math.max(0, night - 0.2) * 0.75;
    for (const o of this.group.children) if (o.userData.pool) o.visible = on;
    // signals
    this.sigTimer -= dt;
    if (this.sigTimer <= 0 && this.sigMeshes.length) {
      this.sigTimer = 0.25;
      const sigs = this.world.city.signals;
      const col = _c;
      for (let k = 0; k < sigs.length; k++) {
        const st = signalColor(sigs[k].node, sigs[k].phase, simTime);
        this.sigMeshes[0].setColorAt(k, st === 0 ? col.setRGB(3.2, 0.12, 0.08) : col.setRGB(0.07, 0.01, 0.01));
        this.sigMeshes[1].setColorAt(k, st === 1 ? col.setRGB(3.0, 1.7, 0.1) : col.setRGB(0.06, 0.04, 0.01));
        this.sigMeshes[2].setColorAt(k, st === 2 ? col.setRGB(0.15, 2.8, 0.7) : col.setRGB(0.01, 0.05, 0.02));
      }
      for (const im of this.sigMeshes) im.instanceColor!.needsUpdate = true;
    }
  }
}
const _c = new THREE.Color();
