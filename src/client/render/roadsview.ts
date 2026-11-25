// Road rendering: carriageways, sidewalks, kerbs, junction patches, Swiss road markings, tram rails, bridges.
import * as THREE from 'three';
import { Rng, clamp } from '../../shared/math';
import { World } from '../../shared/world/world';
import { WORLD_HALF, Zone } from '../../shared/world/layout';
import { EdgePos, RoadEdge, edgePos } from '../../shared/world/roads';
import { MeshBuilder } from './meshbuilder';
import { Quality, U, patchMaterial, replaceOnce } from './globals';
import { makeAsphalt, makeTerrainDetail } from './textures';
import { CHUNK, CHUNKS } from './terrain';

const KERB = 0.15;
const WHITE: [number, number, number] = [0.86, 0.86, 0.84];
const YELLOW: [number, number, number] = [0.92, 0.7, 0.08];
const BLUE: [number, number, number] = [0.12, 0.3, 0.72];
const RAIL: [number, number, number] = [0.3, 0.3, 0.32];

interface Station { x: number; y: number; z: number; rx: number; rz: number; s: number; flag: number }

export class RoadsView {
  readonly group = new THREE.Group();
  /** trim distance of every edge at its a/b end (junction patch size) */
  readonly trimA: Float32Array;
  readonly trimB: Float32Array;
  private asphalt: MeshBuilder[] = [];
  private cobble: MeshBuilder[] = [];
  private marks: MeshBuilder[] = [];
  private struct: MeshBuilder[] = [];
  private lights: MeshBuilder[] = [];
  private ep: EdgePos = { x: 0, y: 0, z: 0, tx: 0, tz: 0, flag: 0 };

  constructor(private world: World, quality: Quality) {
    const g = world.roads;
    this.trimA = new Float32Array(g.edges.length);
    this.trimB = new Float32Array(g.edges.length);
    for (let i = 0; i < CHUNKS * CHUNKS; i++) {
      this.asphalt.push(new MeshBuilder({ floatColor: true }));
      this.cobble.push(new MeshBuilder({ floatColor: true }));
      this.marks.push(new MeshBuilder());
      this.struct.push(new MeshBuilder({ floatColor: true }));
      this.lights.push(new MeshBuilder({ floatColor: true }));
    }
    // --- trims
    for (const n of g.nodes) {
      for (const ei of n.edges) {
        const e = g.edges[ei];
        let t = 0;
        if (n.edges.length >= 2) {
          for (const ej of n.edges) {
            if (ej === ei) continue;
            const o = g.edges[ej];
            t = Math.max(t, o.width / 2 + (e.sidewalk > 0 ? o.sidewalk : 0) + 0.4);
          }
          if (n.edges.length === 2) t = Math.min(t, 3);
        }
        t = Math.min(t, e.length * 0.45);
        if (e.a === n.id) this.trimA[ei] = t;
        else this.trimB[ei] = t;
      }
    }
    for (const e of g.edges) this.buildEdge(e);
    for (const n of g.nodes) this.buildJunction(n.id);

    // --- materials
    const asph = makeAsphalt(512);
    asph.map.anisotropy = quality.anisotropy;
    asph.normal.anisotropy = quality.anisotropy;
    const wetPatch = (m: THREE.MeshStandardMaterial, key: string) =>
      patchMaterial(m, key, (sh) => {
        sh.uniforms.uWet = U.uWet;
        sh.uniforms.uSnow = U.uSnow;
        sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <common>', '#include <common>\nuniform float uWet; uniform float uSnow;');
        sh.fragmentShader = replaceOnce(sh.fragmentShader, '#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
float puddle = uWet * smoothstep(0.1, 0.16, diffuseColor.r + diffuseColor.g) ;
roughnessFactor = mix(roughnessFactor, 0.16, uWet * 0.85);
diffuseColor.rgb *= 1.0 - uWet * 0.35;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.83, 0.88), uSnow * 0.55);`);
      });
    const mAsph = new THREE.MeshStandardMaterial({ map: asph.map, normalMap: asph.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.88, metalness: 0, vertexColors: true });
    wetPatch(mAsph, 'road-asphalt');
    const det = makeTerrainDetail(256);
    const mCobble = new THREE.MeshStandardMaterial({ map: det.paved.map, normalMap: det.paved.normal, roughness: 0.82, metalness: 0, vertexColors: true });
    wetPatch(mCobble, 'road-cobble');
    const mMarks = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const mStruct = new THREE.MeshStandardMaterial({ map: det.rock.map, vertexColors: true, roughness: 0.9, metalness: 0 });
    const add = (builders: MeshBuilder[], mat: THREE.Material, cast: boolean, maxDist: number) => {
      builders.forEach((b, i) => {
        if (b.empty) return;
        const mesh = new THREE.Mesh(b.build(), mat);
        mesh.receiveShadow = true;
        mesh.castShadow = cast;
        mesh.matrixAutoUpdate = false;
        mesh.userData.maxDist = maxDist;
        mesh.userData.center = new THREE.Vector3(((i % CHUNKS) + 0.5) * CHUNK - WORLD_HALF, 0, (Math.floor(i / CHUNKS) + 0.5) * CHUNK - WORLD_HALF);
        this.group.add(mesh);
      });
    };
    add(this.asphalt, mAsph, false, 1);
    add(this.cobble, mCobble, false, 1);
    add(this.marks, mMarks, false, 0.35);
    add(this.struct, mStruct, true, 1.2);
    add(this.lights, new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false }), false, 0.6);
    this.asphalt = this.cobble = this.marks = this.struct = this.lights = [];
  }

  /** Hide distant road meshes (terrain vertex colours take over, avoids far z-fighting). */
  update(cam: THREE.Vector3, viewDist: number): void {
    const base = Math.min(viewDist, 1500);
    for (const m of this.group.children) {
      const c = m.userData.center as THREE.Vector3;
      const dx = Math.max(0, Math.abs(cam.x - c.x) - CHUNK / 2), dz = Math.max(0, Math.abs(cam.z - c.z) - CHUNK / 2);
      m.visible = dx * dx + dz * dz < (base * m.userData.maxDist) ** 2;
    }
  }

  private chunk(x: number, z: number): number {
    const cx = clamp(Math.floor((x + WORLD_HALF) / CHUNK), 0, CHUNKS - 1), cz = clamp(Math.floor((z + WORLD_HALF) / CHUNK), 0, CHUNKS - 1);
    return cz * CHUNKS + cx;
  }

  private station(e: RoadEdge, s: number): Station {
    const p = edgePos(e, s, this.ep);
    // smooth tangent over ±3 m so cross sections do not twist at sample joints
    const a = edgePos(e, Math.max(0, s - 3), _ep2), ax = a.x, az = a.z;
    const b = edgePos(e, Math.min(e.length, s + 3), _ep2);
    let tx = b.x - ax, tz = b.z - az;
    const l = Math.sqrt(tx * tx + tz * tz) || 1;
    tx /= l; tz /= l;
    edgePos(e, s, this.ep);
    return { x: p.x, y: p.y, z: p.z, rx: -tz, rz: tx, s, flag: p.flag };
  }

  private stations(e: RoadEdge, s0: number, s1: number, step = 6): Station[] {
    const out: Station[] = [];
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    for (let i = 0; i <= n; i++) out.push(this.station(e, s0 + ((s1 - s0) * i) / n));
    return out;
  }

  private buildEdge(e: RoadEdge): void {
    const w = this.world;
    const s0 = this.trimA[e.id], s1 = e.length - this.trimB[e.id];
    if (s1 - s0 < 0.5) return;
    const st = this.stations(e, s0, s1, e.type === 'highway' ? 8 : 5);
    const hw = e.width / 2, sw = e.sidewalk;
    const cobble = e.type === 'alley';
    const zone = w.zoneAt(e.px[e.n >> 1], e.pz[e.n >> 1]);
    const urban = zone === Zone.OldTown || zone === Zone.Downtown || zone === Zone.Business || zone === Zone.Residential || zone === Zone.Hillside || zone === Zone.Industrial || zone === Zone.Village;
    const roadCol: [number, number, number] = cobble ? [0.66, 0.61, 0.56] : e.type === 'highway' ? [1.12, 1.12, 1.14] : e.type === 'rural' ? [1.05, 1.04, 1.02] : [0.96, 0.96, 0.98];
    const walkCol: [number, number, number] = [2.5, 2.45, 2.38];
    const kerbCol: [number, number, number] = [3.3, 3.3, 3.25];
    const shoulderCol: [number, number, number] = cobble ? [0.6, 0.56, 0.52] : [1.5, 1.42, 1.2];

    for (let i = 0; i < st.length - 1; i++) {
      const a = st[i], b = st[i + 1];
      const ci = this.chunk((a.x + b.x) / 2, (a.z + b.z) / 2);
      const B = cobble ? this.cobble[ci] : this.asphalt[ci];
      const P = (q: Station, off: number, dy: number): [number, number, number] => [q.x + q.rx * off, q.y + dy, q.z + q.rz * off];
      // strip between lateral offsets o0→o1 (left to right), heights d0,d1
      const strip = (o0: number, d0: number, o1: number, d1: number, col: [number, number, number], bld = B) => {
        const p0 = P(a, o0, d0), p1 = P(a, o1, d1), p2 = P(b, o1, d1), p3 = P(b, o0, d0);
        bld.color(col[0], col[1], col[2]);
        bld.quad(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], o0 * 0.25, a.s * 0.25, o1 * 0.25, b.s * 0.25);
      };
      const bridge = a.flag === 1 || b.flag === 1;
      const tunnel = a.flag === 2 || b.flag === 2;
      strip(-hw, 0, hw, 0, roadCol);
      if (tunnel) {
        this.tunnelSegment(e, a, b, st[i - 1]?.flag !== 2 && a.flag !== 2 ? 1 : 0, i);
        continue;
      }
      if (sw > 0) {
        strip(-hw - sw, KERB, -hw, KERB, walkCol);
        strip(-hw, KERB, -hw, 0, kerbCol);
        strip(hw, 0, hw, KERB, kerbCol);
        strip(hw, KERB, hw + sw, KERB, walkCol);
        if (!bridge) {
          strip(-hw - sw, -0.5, -hw - sw, KERB, walkCol);
          strip(hw + sw, KERB, hw + sw, -0.5, walkCol);
        }
      } else if (!bridge) {
        strip(-hw - 1.5, -0.55, -hw, 0, shoulderCol);
        strip(hw, 0, hw + 1.5, -0.55, shoulderCol);
      }
      if (bridge) this.bridgeSegment(e, a, b, i);
      else if (e.type === 'highway' && i % 1 === 0) {
        // central barrier
        const S = this.struct[ci];
        S.color(1.5, 1.5, 1.5);
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, my = (a.y + b.y) / 2;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const tx = (b.x - a.x) / len, tz = (b.z - a.z) / len;
        S.box(mx, my + 0.42, mz, 0.22, 0.42, len / 2, tx, tz, 0.3);
      } else if (e.type === 'rural' && !urban) {
        // guard rail on the downhill side where the terrain falls away
        for (const side of [-1, 1]) {
          const ox = (a.x + b.x) / 2 + a.rx * side * (hw + 4.5), oz = (a.z + b.z) / 2 + a.rz * side * (hw + 4.5);
          if (w.visAt(ox, oz) < (a.y + b.y) / 2 - 1.6) {
            const S = this.struct[ci];
            S.color(1.9, 1.9, 1.95);
            const mx = (a.x + b.x) / 2 + a.rx * side * (hw + 0.55), mz = (a.z + b.z) / 2 + a.rz * side * (hw + 0.55), my = (a.y + b.y) / 2;
            const len = Math.hypot(b.x - a.x, b.z - a.z);
            const tx = (b.x - a.x) / len, tz = (b.z - a.z) / len;
            S.box(mx, my + 0.52, mz, 0.05, 0.16, len / 2, tx, tz, 0.3, true, true);
            if (i % 2 === 0) S.box(a.x + a.rx * side * (hw + 0.6), a.y + 0.25, a.z + a.rz * side * (hw + 0.6), 0.05, 0.3, 0.05, tx, tz, 0.3, false);
          }
        }
      }
    }
    this.markings(e, s0, s1, urban);
  }

  /** Tunnel lining (walls, ceiling, lamp strip) plus the portal frame at both mouths. */
  private tunnelSegment(e: RoadEdge, a: Station, b: Station, _first: number, i: number): void {
    const ci = this.chunk((a.x + b.x) / 2, (a.z + b.z) / 2);
    const S = this.struct[ci];
    const half = e.width / 2 + 0.9, H = 5.9;
    const P = (q: Station, off: number, dy: number): [number, number, number] => [q.x + q.rx * off, q.y + dy, q.z + q.rz * off];
    const quad = (p0: number[], p1: number[], p2: number[], p3: number[], col: [number, number, number]) => {
      S.color(col[0], col[1], col[2]);
      S.quad(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], 0, 0, 1.5, 1.5);
    };
    const wall: [number, number, number] = [0.9, 0.9, 0.88], dark: [number, number, number] = [0.55, 0.55, 0.56];
    // inward facing: left wall (offset -half) faces +offset, right wall faces -offset, ceiling faces down
    quad(P(a, -half, -0.1), P(b, -half, -0.1), P(b, -half, H), P(a, -half, H), wall);
    quad(P(b, half, -0.1), P(a, half, -0.1), P(a, half, H), P(b, half, H), wall);
    quad(P(a, -half, H), P(b, -half, H), P(b, half, H), P(a, half, H), dark);
    // kerb strips at the foot of the walls
    quad(P(a, -half + 0.9, 0.02), P(a, -half, 0.25), P(b, -half, 0.25), P(b, -half + 0.9, 0.02), dark);
    quad(P(a, half, 0.25), P(a, half - 0.9, 0.02), P(b, half - 0.9, 0.02), P(b, half, 0.25), dark);
    // lamp strip
    if (i % 2 === 0) {
      const L = this.lights[ci];
      for (const off of [-half * 0.45, half * 0.45]) {
        const p0 = P(a, off - 0.35, H - 0.06), p1 = P(a, off + 0.35, H - 0.06), q0 = P(a, off - 0.35, H - 0.06), q1 = P(a, off + 0.35, H - 0.06);
        const tx = (b.x - a.x) * 0.35, tz = (b.z - a.z) * 0.35, ty = (b.y - a.y) * 0.35;
        q0[0] += tx; q0[1] += ty; q0[2] += tz; q1[0] += tx; q1[1] += ty; q1[2] += tz;
        L.color(3.2, 2.7, 1.8);
        L.quad(p0[0], p0[1], p0[2], q0[0], q0[1], q0[2], q1[0], q1[1], q1[2], p1[0], p1[1], p1[2]);
      }
    }
    // portal frame where the tunnel meets the open road
    for (const [q, open] of [[a, a.flag !== 2], [b, b.flag !== 2]] as [Station, boolean][]) {
      if (!open) continue;
      const tx = q.rz, tz = -q.rx;
      S.color(1.25, 1.24, 1.2);
      for (const side of [-1, 1]) S.box(q.x + q.rx * side * (half + 0.9), q.y + 3.6, q.z + q.rz * side * (half + 0.9), 0.9, 3.9, 1.1, tx, tz, 0.2);
      S.box(q.x, q.y + H + 1.2, q.z, 1.1, 1.25, half + 1.8, q.rx, q.rz, 0.2);
    }
  }

  private bridgeSegment(e: RoadEdge, a: Station, b: Station, i: number): void {
    const w = this.world;
    const ci = this.chunk((a.x + b.x) / 2, (a.z + b.z) / 2);
    const S = this.struct[ci];
    const half = e.width / 2 + e.sidewalk;
    const top = e.sidewalk > 0 ? KERB : 0;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const tx = (b.x - a.x) / len, tz = (b.z - a.z) / len;
    // deck slab (under the road surface)
    S.color(1.25, 1.22, 1.18);
    S.box(mx, my - 0.5, mz, half + 0.25, 0.45, len / 2 + 0.02, tx, tz, 0.25, false, true);
    // parapets
    S.color(1.5, 1.46, 1.4);
    for (const side of [-1, 1]) {
      const ox = mx + a.rx * side * (half + 0.05), oz = mz + a.rz * side * (half + 0.05);
      S.box(ox, my + top + 0.5, oz, 0.2, 0.55, len / 2 + 0.02, tx, tz, 0.25);
    }
    // piers
    if (i % 3 === 1) {
      const ground = w.visAt(mx, mz);
      if (my - ground > 2.2) {
        S.color(1.15, 1.12, 1.08);
        const h = my - 0.9 - ground + 1.5;
        S.box(mx, ground - 1.5 + h / 2, mz, half * 0.82, h / 2, 1.0, tx, tz, 0.25, false);
      }
    }
  }

  private line(e: RoadEdge, s0: number, s1: number, off: number, width: number, col: [number, number, number], lift = 0.022): void {
    if (s1 - s0 < 0.2) return;
    const st = this.stations(e, s0, s1, 5);
    for (let i = 0; i < st.length - 1; i++) {
      const a = st[i], b = st[i + 1];
      const M = this.marks[this.chunk(a.x, a.z)];
      M.color(col[0], col[1], col[2]);
      const o0 = off - width / 2, o1 = off + width / 2;
      M.quad(a.x + a.rx * o0, a.y + lift, a.z + a.rz * o0, a.x + a.rx * o1, a.y + lift, a.z + a.rz * o1, b.x + b.rx * o1, b.y + lift, b.z + b.rz * o1, b.x + b.rx * o0, b.y + lift, b.z + b.rz * o0);
    }
  }
  private dashed(e: RoadEdge, s0: number, s1: number, off: number, width: number, dash: number, gap: number, col: [number, number, number]): void {
    for (let s = s0; s < s1 - dash * 0.5; s += dash + gap) this.line(e, s, Math.min(s1, s + dash), off, width, col);
  }

  private markings(e: RoadEdge, s0: number, s1: number, urban: boolean): void {
    const g = this.world.roads;
    const hw = e.width / 2;
    const rng = new Rng(e.id * 31 + 7);
    const sigA = g.nodes[e.a].signal, sigB = g.nodes[e.b].signal;
    const junA = g.nodes[e.a].edges.length >= 3, junB = g.nodes[e.b].edges.length >= 3;
    if (e.type === 'alley') return;
    if (e.type === 'highway') {
      this.line(e, s0, s1, -0.9, 0.16, WHITE);
      this.line(e, s0, s1, 0.9, 0.16, WHITE);
      this.dashed(e, s0, s1, -4.55, 0.15, 6, 12, WHITE);
      this.dashed(e, s0, s1, 4.55, 0.15, 6, 12, WHITE);
      this.line(e, s0, s1, -hw + 0.6, 0.18, WHITE);
      this.line(e, s0, s1, hw - 0.6, 0.18, WHITE);
      return;
    }
    // crosswalks + stop lines
    let a0 = s0, a1 = s1;
    const zebra = (atA: boolean, signal: boolean) => {
      const base = atA ? s0 + 0.8 : s1 - 0.8 - 4;
      for (let o = -hw + 0.55; o < hw - 0.3; o += 1.0) this.line(e, base, base + 4, o, 0.5, YELLOW);
      if (signal) {
        // stop line across the incoming lane (traffic drives on the right)
        const sl = atA ? base + 5.2 : base - 1.6;
        const st = this.station(e, sl + 0.2);
        const M = this.marks[this.chunk(st.x, st.z)];
        M.color(WHITE[0], WHITE[1], WHITE[2]);
        const oA = atA ? -hw + 0.3 : 0.1, oB = atA ? -0.1 : hw - 0.3;
        const tx = st.rz, tz = -st.rx; // forward
        const q = (o: number, f: number): [number, number, number] => [st.x + st.rx * o + tx * f, st.y + 0.022, st.z + st.rz * o + tz * f];
        const p0 = q(oA, -0.2), p1 = q(oA, 0.2), p2 = q(oB, 0.2), p3 = q(oB, -0.2);
        M.quad(p0[0], p0[1], p0[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2], p1[0], p1[1], p1[2]);
      }
      if (atA) a0 = base + 6.5;
      else a1 = base - 2.5;
    };
    if (e.sidewalk > 0 && e.length > 26) {
      if (junA && (sigA || rng.chance(urban ? 0.55 : 0))) zebra(true, sigA);
      if (junB && (sigB || rng.chance(urban ? 0.55 : 0))) zebra(false, sigB);
    }
    if (a1 - a0 < 4) return;
    // centre line
    if (e.type === 'main') {
      if (e.tram) {
        for (const c of [-1.75, 1.75]) for (const r of [-0.72, 0.72]) this.line(e, s0, s1, c + r, 0.07, RAIL, 0.018);
        this.dashed(e, a0, a1, 0, 0.12, 3, 6, WHITE);
      } else {
        const solidA = sigA ? 18 : 0, solidB = sigB ? 18 : 0;
        if (solidA) this.line(e, a0, Math.min(a1, a0 + solidA), 0, 0.14, WHITE);
        if (solidB) this.line(e, Math.max(a0, a1 - solidB), a1, 0, 0.14, WHITE);
        this.dashed(e, a0 + solidA, a1 - solidB, 0, 0.14, 3, 6, WHITE);
        // blue-zone parking strip
        this.dashed(e, a0 + 8, a1 - 8, -hw + 2.25, 0.1, 5, 1.2, BLUE);
        this.dashed(e, a0 + 8, a1 - 8, hw - 2.25, 0.1, 5, 1.2, BLUE);
      }
    } else if (e.type === 'street') {
      if (urban) this.dashed(e, a0, a1, 0, 0.1, 2, 6, WHITE);
      else this.dashed(e, a0, a1, 0, 0.12, 4, 8, WHITE);
    } else if (e.type === 'rural') {
      this.dashed(e, a0, a1, 0, 0.13, 4, 8, WHITE);
      this.line(e, s0, s1, -hw + 0.22, 0.12, WHITE);
      this.line(e, s0, s1, hw - 0.22, 0.12, WHITE);
    }
  }

  private buildJunction(nodeId: number): void {
    const g = this.world.roads;
    const n = g.nodes[nodeId];
    if (n.edges.length < 2) return;
    interface End { e: RoadEdge; ang: number; cx: number; cy: number; cz: number; dx: number; dz: number; hw: number; sw: number }
    const ends: End[] = [];
    for (const ei of n.edges) {
      const e = g.edges[ei];
      const atA = e.a === nodeId;
      const t = atA ? this.trimA[ei] : this.trimB[ei];
      const st = this.station(e, atA ? t : e.length - t);
      // direction pointing away from the node
      let dx = st.rz, dz = -st.rx;
      if (!atA) { dx = -dx; dz = -dz; }
      ends.push({ e, ang: Math.atan2(dz, dx), cx: st.x, cy: st.y, cz: st.z, dx, dz, hw: e.width / 2, sw: e.sidewalk });
    }
    ends.sort((a, b) => a.ang - b.ang);
    const ci = this.chunk(n.x, n.z);
    const allCobble = ends.every((q) => q.e.type === 'alley');
    const B = allCobble ? this.cobble[ci] : this.asphalt[ci];
    const col: [number, number, number] = allCobble ? [0.66, 0.61, 0.56] : [0.96, 0.96, 0.98];
    // corner points: for direction d, "left" of d is (dz, -dx) rotated... use perpendicular p = (-dz, dx) (counter-clockwise side in x/z-angle space)
    const corner = (q: End, sideCcw: number, off: number): [number, number, number] => [q.cx + -q.dz * sideCcw * off, q.cy, q.cz + q.dx * sideCcw * off];
    const m = ends.length;
    for (let k = 0; k < m; k++) {
      const q = ends[k], nx = ends[(k + 1) % m];
      const cw = corner(q, -1, q.hw), ccw = corner(q, 1, q.hw);
      const nextCw = corner(nx, -1, nx.hw);
      B.color(col[0], col[1], col[2]);
      // fan: centre, this edge's mouth, then gap to the next edge. Angles increase → in x/z this is clockwise seen from above (y up), so order vertices reversed.
      const uv = (p: [number, number, number]) => [p[0] * 0.25, p[2] * 0.25];
      const tri = (p0: [number, number, number], p1: [number, number, number], p2: [number, number, number]) => {
        const u0 = uv(p0), u1 = uv(p1), u2 = uv(p2);
        // ensure upward-facing
        const ux = p1[0] - p0[0], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vz = p2[2] - p0[2];
        if (uz * vx - ux * vz > 0) B.tri(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], u0[0], u0[1], u1[0], u1[1], u2[0], u2[1]);
        else B.tri(p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p1[0], p1[1], p1[2], u0[0], u0[1], u2[0], u2[1], u1[0], u1[1]);
      };
      const c: [number, number, number] = [n.x, n.y, n.z];
      tri(c, cw, ccw);
      if (m > 2 || true) tri(c, ccw, nextCw);
      // sidewalk corner between this edge (ccw side) and the next edge (cw side)
      if (q.sw > 0 && nx.sw > 0 && m >= 2) {
        const o0 = corner(q, 1, q.hw + q.sw), o1 = corner(nx, -1, nx.hw + nx.sw);
        // outer corner point: intersection-ish of the two sidewalk outer lines → average pushed outwards
        const ox = (o0[0] + o1[0]) / 2, oz = (o0[2] + o1[2]) / 2;
        const vx = ox - n.x, vz = oz - n.z;
        const vl = Math.hypot(vx, vz) || 1;
        const push = Math.min(q.sw, nx.sw) * 0.35;
        const oc: [number, number, number] = [ox + (vx / vl) * push, (o0[1] + o1[1]) / 2, oz + (vz / vl) * push];
        B.color(2.5, 2.45, 2.38);
        const up = (p: [number, number, number]): [number, number, number] => [p[0], p[1] + KERB, p[2]];
        tri(up(ccw), up(o0), up(oc));
        tri(up(ccw), up(oc), up(nextCw));
        tri(up(nextCw), up(oc), up(o1));
        // kerb face along the carriageway corner
        B.color(3.3, 3.3, 3.25);
        B.quad(ccw[0], ccw[1], ccw[2], nextCw[0], nextCw[1], nextCw[2], nextCw[0], nextCw[1] + KERB, nextCw[2], ccw[0], ccw[1] + KERB, ccw[2], 0, 0, 1, 0.2);
        B.quad(nextCw[0], nextCw[1], nextCw[2], ccw[0], ccw[1], ccw[2], ccw[0], ccw[1] + KERB, ccw[2], nextCw[0], nextCw[1] + KERB, nextCw[2], 0, 0, 1, 0.2);
        // outer skirts
        B.color(2.5, 2.45, 2.38);
        const sk = (p0: [number, number, number], p1: [number, number, number]) => {
          B.quad(p0[0], p0[1] - 0.5, p0[2], p1[0], p1[1] - 0.5, p1[2], p1[0], p1[1] + KERB, p1[2], p0[0], p0[1] + KERB, p0[2], 0, 0, 1, 0.2);
          B.quad(p1[0], p1[1] - 0.5, p1[2], p0[0], p0[1] - 0.5, p0[2], p0[0], p0[1] + KERB, p0[2], p1[0], p1[1] + KERB, p1[2], 0, 0, 1, 0.2);
        };
        sk(o0, oc);
        sk(oc, o1);
      }
    }
  }
}
const _ep2: EdgePos = { x: 0, y: 0, z: 0, tx: 0, tz: 0, flag: 0 };
