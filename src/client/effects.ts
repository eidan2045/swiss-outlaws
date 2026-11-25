// Visual effects: activity / mission markers, collectibles, bullet tracers, explosions, rain and snow.
import * as THREE from 'three';
import type { World } from '../shared/world/world';
import { ACTIVITIES, SECRETS } from '../shared/sim/missions';
import { U } from './render/globals';

const KIND_COLOR: Record<string, number> = { story: 0xffc21a, race: 0x35c2ff, delivery: 0x54e08a, dealer: 0xffffff, garage: 0xffffff };

export class Effects {
  readonly group = new THREE.Group();
  private pillars: { mesh: THREE.Mesh; id: string }[] = [];
  private target: THREE.Mesh;
  private targetRing: THREE.Mesh;
  private coins: THREE.Mesh[] = [];
  private tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private tracerPool: THREE.Mesh[] = [];
  private booms: { mesh: THREE.Mesh; light: THREE.PointLight; life: number }[] = [];
  private rain: THREE.LineSegments;
  private snow: THREE.Points;
  private rainU = { uTime: U.uTime, uAmount: { value: 0 }, uCam: U.uCamPos, uWind: U.uWind };
  private t = 0;
  flash = 0;
  private flashT = 3;

  constructor(private world: World) {
    const pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
    pillarGeo.translate(0, 0.5, 0);
    for (const a of ACTIVITIES) {
      const mat = new THREE.MeshBasicMaterial({ color: KIND_COLOR[a.kind] ?? 0xffffff, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const m = new THREE.Mesh(pillarGeo, mat);
      const y = world.groundAt(a.x, a.z);
      m.position.set(a.x, y, a.z);
      m.scale.set(1.6, a.kind === 'dealer' || a.kind === 'garage' ? 1.2 : 2.6, 1.6);
      this.group.add(m);
      this.pillars.push({ mesh: m, id: a.id });
    }
    this.target = new THREE.Mesh(pillarGeo, new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.target.visible = false;
    const ringGeo = new THREE.RingGeometry(0.86, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.targetRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.85, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
    this.targetRing.visible = false;
    this.group.add(this.target, this.targetRing);
    // collectibles
    const coinGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.05, 20);
    coinGeo.rotateX(Math.PI / 2);
    const coinMat = new THREE.MeshStandardMaterial({ color: 0xffc94a, metalness: 1, roughness: 0.22, emissive: 0x553300, emissiveIntensity: 0.9 });
    SECRETS.forEach((s) => {
      const m = new THREE.Mesh(coinGeo, coinMat);
      m.position.set(s.x, world.groundAt(s.x, s.z) + 1.1, s.z);
      m.castShadow = true;
      this.group.add(m);
      this.coins.push(m);
    });

    // ---- precipitation
    const N = 2600;
    const rp = new Float32Array(N * 6), rs = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      rp.set([x, y, z, x, y, z], i * 6);
      rs[i * 2] = 0; rs[i * 2 + 1] = 1;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rg.setAttribute('aEnd', new THREE.BufferAttribute(rs, 1));
    rg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({
      uniforms: this.rainU,
      transparent: true, depthWrite: false, fog: false,
      vertexShader: `
uniform float uTime; uniform float uAmount; uniform vec3 uCam; uniform vec3 uWind;
attribute float aEnd; varying float vA;
void main() {
  vec3 box = vec3(44.0, 26.0, 44.0);
  vec3 p = position * box;
  float speed = 21.0 + position.x * 9.0;
  p.y = mod(p.y - uTime * speed, box.y);
  p.xz += uWind.xz * (box.y - p.y) * 0.07;
  vec3 base = floor(uCam / box) * box;
  vec3 w = base + p;
  // wrap around the camera
  w = uCam + mod(w - uCam + box * 0.5, box) - box * 0.5;
  w.y += aEnd * (0.55 + position.z * 0.5);
  w.xz += uWind.xz * aEnd * 0.045;
  vA = step(position.y, uAmount) * (0.18 + 0.2 * aEnd);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`,
      fragmentShader: `varying float vA; void main() { if (vA <= 0.001) discard; gl_FragColor = vec4(0.75, 0.82, 0.92, vA); }`,
    }));
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 8;
    const sg = new THREE.BufferGeometry();
    const sp = new Float32Array(1800 * 3);
    for (let i = 0; i < sp.length; i++) sp[i] = Math.random();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.snow = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uAmount: { value: 0 }, uCam: U.uCamPos, uWind: U.uWind },
      transparent: true, depthWrite: false, fog: false,
      vertexShader: `
uniform float uTime; uniform float uAmount; uniform vec3 uCam; uniform vec3 uWind;
varying float vA;
void main() {
  vec3 box = vec3(36.0, 22.0, 36.0);
  vec3 p = position * box;
  p.y = mod(p.y - uTime * (1.6 + position.x * 1.4), box.y);
  p.x += sin(uTime * 0.9 + position.z * 30.0) * 0.6 + uWind.x * (box.y - p.y) * 0.25;
  p.z += cos(uTime * 0.7 + position.x * 30.0) * 0.6 + uWind.z * (box.y - p.y) * 0.25;
  vec3 w = uCam + mod(floor(uCam / box) * box + p - uCam + box * 0.5, box) - box * 0.5;
  vA = step(position.y, uAmount);
  vec4 mv = viewMatrix * vec4(w, 1.0);
  gl_PointSize = clamp(64.0 / -mv.z, 1.0, 7.0);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `varying float vA; void main() { vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.1, length(d)) * vA; if (a <= 0.01) discard; gl_FragColor = vec4(0.95, 0.97, 1.0, a * 0.85); }`,
    }));
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 8;
    this.group.add(this.rain, this.snow);
  }

  tracer(x: number, y: number, z: number, hx: number, hy: number, hz: number): void {
    let m = this.tracerPool.pop();
    if (!m) {
      const g = new THREE.CylinderGeometry(0.012, 0.012, 1, 4, 1, true);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, 0.5);
      m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      this.group.add(m);
    }
    m.visible = true;
    m.position.set(x, y, z);
    m.lookAt(hx, hy, hz);
    m.scale.set(1, 1, Math.max(0.5, Math.hypot(hx - x, hy - y, hz - z)));
    this.tracers.push({ mesh: m, life: 0.07 });
  }
  explode(x: number, y: number, z: number): void {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    mesh.position.set(x, y + 0.6, z);
    const light = new THREE.PointLight(0xff8a30, 900, 60, 1.6);
    light.position.copy(mesh.position).y += 1.5;
    this.group.add(mesh, light);
    this.booms.push({ mesh, light, life: 0.7 });
  }

  update(dt: number, opts: { rain: number; snow: number; secrets: number[]; mission: { x: number; z: number; r: number } | null; hideActivities: boolean; cam: THREE.Vector3 }): void {
    this.t += dt;
    const pulse = 0.26 + 0.1 * Math.sin(this.t * 3);
    for (const p of this.pillars) {
      p.mesh.visible = !opts.hideActivities && p.mesh.position.distanceToSquared(opts.cam) < 420 * 420;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = pulse;
    }
    if (opts.mission) {
      const y = this.world.groundAt(opts.mission.x, opts.mission.z);
      this.target.visible = this.targetRing.visible = true;
      this.target.position.set(opts.mission.x, y, opts.mission.z);
      const d = Math.sqrt(this.target.position.distanceToSquared(opts.cam));
      this.target.scale.set(opts.mission.r, 6 + Math.min(60, d * 0.12), opts.mission.r);
      (this.target.material as THREE.MeshBasicMaterial).opacity = pulse + 0.05;
      this.targetRing.position.set(opts.mission.x, y + 0.12, opts.mission.z);
      this.targetRing.scale.setScalar(opts.mission.r);
    } else this.target.visible = this.targetRing.visible = false;
    for (let i = 0; i < this.coins.length; i++) {
      const c = this.coins[i];
      c.visible = !opts.secrets.includes(i) && c.position.distanceToSquared(opts.cam) < 140 * 140;
      if (c.visible) c.rotation.y = this.t * 2.2 + i;
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, t.life / 0.07) * 0.9;
      if (t.life <= 0) { t.mesh.visible = false; this.tracerPool.push(t.mesh); this.tracers.splice(i, 1); }
    }
    for (let i = this.booms.length - 1; i >= 0; i--) {
      const b = this.booms[i];
      b.life -= dt;
      const k = 1 - b.life / 0.7;
      b.mesh.scale.setScalar(1 + k * 9);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k * 1.3);
      b.light.intensity = 900 * Math.max(0, 1 - k * 1.6);
      if (b.life <= 0) { this.group.remove(b.mesh, b.light); b.mesh.geometry.dispose(); this.booms.splice(i, 1); }
    }
    this.rainU.uAmount.value = opts.rain;
    this.rain.visible = opts.rain > 0.02;
    (this.snow.material as THREE.ShaderMaterial).uniforms.uAmount.value = opts.snow;
    this.snow.visible = opts.snow > 0.02;
    // thunderstorm lightning
    if (opts.rain > 0.8) {
      this.flashT -= dt;
      if (this.flashT <= 0) { this.flashT = 4 + Math.random() * 9; this.flash = 1; }
    }
    this.flash = Math.max(0, this.flash - dt * 4.5);
  }
}
