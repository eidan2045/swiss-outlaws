// Sky dome, sun/moon lighting, time of day, fog and image-based ambient light.
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../../shared/math';
import { Quality, U } from './globals';
import { makeNoiseRGBA } from './textures';

const LAT = 47.37 * Math.PI / 180;
const DECL = 14 * Math.PI / 180; // late spring / late summer

/** Sun direction for a local solar time in hours. +X east, +Y up, +Z south. */
export function sunDirection(hours: number, out: THREE.Vector3, decl = DECL): THREE.Vector3 {
  const H = (hours - 12) * 15 * Math.PI / 180;
  const sinEl = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H);
  const east = -Math.cos(decl) * Math.sin(H);
  const north = Math.cos(LAT) * Math.sin(decl) - Math.sin(LAT) * Math.cos(decl) * Math.cos(H);
  return out.set(east, sinEl, -north).normalize();
}

interface Key { e: number; zen: number[]; hor: number[]; sun: number[]; sunI: number; amb: number }
// keyed by sun elevation in degrees (linear colour, HDR)
const KEYS: Key[] = [
  { e: -90, zen: [0.0016, 0.0028, 0.008], hor: [0.006, 0.009, 0.02], sun: [1, 0.5, 0.2], sunI: 0, amb: 0.08 },
  { e: -14, zen: [0.0018, 0.003, 0.009], hor: [0.007, 0.011, 0.026], sun: [1, 0.5, 0.2], sunI: 0, amb: 0.08 },
  { e: -7, zen: [0.008, 0.016, 0.052], hor: [0.06, 0.05, 0.08], sun: [1, 0.45, 0.2], sunI: 0, amb: 0.14 },
  { e: -3, zen: [0.022, 0.05, 0.15], hor: [0.42, 0.2, 0.13], sun: [1, 0.42, 0.16], sunI: 0, amb: 0.3 },
  { e: 0, zen: [0.05, 0.11, 0.3], hor: [0.95, 0.46, 0.2], sun: [1, 0.46, 0.18], sunI: 0.5, amb: 0.5 },
  { e: 4, zen: [0.085, 0.19, 0.46], hor: [0.95, 0.62, 0.36], sun: [1, 0.62, 0.34], sunI: 2.0, amb: 0.75 },
  { e: 10, zen: [0.085, 0.21, 0.55], hor: [0.62, 0.64, 0.68], sun: [1, 0.8, 0.58], sunI: 3.1, amb: 0.9 },
  { e: 25, zen: [0.075, 0.2, 0.6], hor: [0.36, 0.52, 0.8], sun: [1, 0.93, 0.8], sunI: 3.7, amb: 1.0 },
  { e: 90, zen: [0.065, 0.19, 0.62], hor: [0.33, 0.5, 0.8], sun: [1, 0.96, 0.88], sunI: 4.0, amb: 1.0 },
];

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // always at the far plane
}`;
const FRAG = /* glsl */ `
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uMoonDir;
uniform float uSunI; uniform float uNightF; uniform float uTime; uniform float uCover; uniform float uOvercast;
uniform float uDisc; uniform vec2 uCloudOff;
uniform sampler2D tNoise;
varying vec3 vDir;

float cloudDensity(vec2 uv) {
  float n = texture2D(tNoise, uv).r * 0.58 + texture2D(tNoise, uv * 2.6 + 0.37).g * 0.28 + texture2D(tNoise, uv * 6.3 - uCloudOff * 0.7).b * 0.14;
  return n;
}
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.45));
  float sd = max(dot(d, uSunDir), 0.0);
  // atmospheric glow around the sun, stronger near the horizon
  vec3 glowCol = uSunCol * uSunI;
  col += glowCol * (pow(sd, 5.0) * 0.045 + pow(sd, 40.0) * 0.12 + pow(sd, 400.0) * 0.5) * (1.0 - 0.55 * h) * (1.0 - uOvercast);
  // sun disc
  col += glowCol * smoothstep(0.99988, 0.99996, sd) * 30.0 * uDisc * (1.0 - uOvercast);
  // moon
  float md = max(dot(d, uMoonDir), 0.0);
  float moon = smoothstep(0.99975, 0.99988, md);
  col += vec3(0.9, 0.95, 1.0) * (moon * 1.6 + pow(md, 220.0) * 0.06) * uNightF * (1.0 - uOvercast);
  // stars
  if (uNightF > 0.01 && d.y > 0.0) {
    vec2 suv = d.xz / (d.y + 0.35) * 2.6;
    float s = texture2D(tNoise, suv).a * texture2D(tNoise, suv * 1.7 + 0.5).a;
    float tw = 0.75 + 0.25 * sin(uTime * 2.0 + suv.x * 40.0);
    col += vec3(0.85, 0.9, 1.0) * smoothstep(0.80, 0.93, s) * tw * uNightF * 1.4 * smoothstep(0.0, 0.25, d.y) * (1.0 - uCover * 0.8);
  }
  // clouds
  if (d.y > -0.02) {
    vec2 p = d.xz / (d.y + 0.14);
    vec2 uv = p * 0.085 + uCloudOff;
    float n = cloudDensity(uv);
    float edge0 = 1.0 - uCover;
    float cov = smoothstep(edge0 - 0.03, edge0 + 0.22, n);
    if (cov > 0.001) {
      float n2 = cloudDensity(uv + uSunDir.xz * 0.035);
      float lit = clamp(0.55 + (n - n2) * 4.2, 0.0, 1.0);
      vec3 dayLit = mix(uHorizon * 0.9 + uZenith * 0.5, vec3(1.0), 0.72) * (0.35 + 0.65 * min(1.0, uSunI * 0.3)) + glowCol * 0.16;
      vec3 shade = mix(uZenith * 0.55 + uHorizon * 0.35, vec3(0.3, 0.32, 0.36) * (0.2 + min(1.0, uSunI * 0.25)), 0.5);
      vec3 cc = mix(shade, dayLit, lit * (1.0 - 0.6 * uOvercast));
      cc += glowCol * pow(sd, 10.0) * (1.0 - cov) * 0.5; // silver lining
      cc = mix(cc, vec3(0.012, 0.016, 0.028) + uHorizon * 0.6, uNightF * 0.85);
      float fade = smoothstep(-0.02, 0.2, d.y);
      col = mix(col, cc, cov * fade * 0.96);
    }
  }
  col = mix(col, mix(uHorizon, vec3(dot(uHorizon, vec3(0.33))), 0.4) * (1.0 - 0.3 * uOvercast), uOvercast * 0.75 * smoothstep(0.6, 0.0, d.y));
  col = mix(col, uGround, smoothstep(0.0, -0.1, d.y));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface WeatherState {
  /** 0..1 cloud cover */
  cover: number;
  /** 0..1 rain intensity */
  rain: number;
  /** 0..1 fog amount */
  fog: number;
  /** 0..1 snowfall */
  snow: number;
  /** wind strength 0..1 */
  wind: number;
  /** lightning flash 0..1 */
  flash: number;
}

export class SkySystem {
  readonly dome: THREE.Mesh;
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.25);
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  readonly fogColor = new THREE.Color();
  /** 0 day .. 1 night */
  night = 0;
  sunElevation = 0;
  private mat: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private envMat: THREE.ShaderMaterial;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvKey = '';
  private envTimer = 0;
  private cloudOff = new THREE.Vector2();
  private zen = new THREE.Color();
  private hor = new THREE.Color();
  private sunCol = new THREE.Color();
  private focus = new THREE.Vector3();
  private lightDirSmoothed = new THREE.Vector3(0.3, 0.8, 0.5);

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private quality: Quality) {
    const noise = makeNoiseRGBA(256);
    const uniforms = {
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color(0.05, 0.06, 0.05) },
      uSunDir: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() }, uMoonDir: { value: new THREE.Vector3() },
      uSunI: { value: 1 }, uNightF: { value: 0 }, uTime: U.uTime, uCover: { value: 0.4 }, uOvercast: { value: 0 }, uDisc: { value: 1 },
      uCloudOff: { value: this.cloudOff }, tNoise: { value: noise },
    };
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.mat);
    this.dome.scale.setScalar(50);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);

    // environment capture uses the same shader without the sun disc
    this.envMat = this.mat.clone();
    this.envMat.uniforms = { ...uniforms, uDisc: { value: 0 } };
    const envDome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), this.envMat);
    envDome.scale.setScalar(50);
    this.envScene.add(envDome);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.sun.castShadow = quality.shadows;
    this.sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.radius = 2.2;
    const cam = this.sun.shadow.camera;
    cam.near = 1;
    cam.far = 900;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.FogExp2(0xaabbcc, 0.0002);
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.sun.castShadow = q.shadows;
    if (this.sun.shadow.mapSize.x !== q.shadowSize) {
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }

  update(hours: number, weather: WeatherState, camera: THREE.Camera, focus: THREE.Vector3, dt: number): void {
    sunDirection(hours, this.sunDir);
    sunDirection(hours + 12.6, this.moonDir, -8 * Math.PI / 180);
    if (this.moonDir.y < 0.12) this.moonDir.y = 0.12 + (0.12 - this.moonDir.y) * 0.2;
    this.moonDir.normalize();
    const el = Math.asin(clamp(this.sunDir.y, -1, 1)) * 180 / Math.PI;
    this.sunElevation = el;
    let k = 0;
    while (k < KEYS.length - 2 && KEYS[k + 1].e < el) k++;
    const a = KEYS[k], b = KEYS[k + 1];
    const t = clamp01((el - a.e) / (b.e - a.e));
    const overcast = clamp01(weather.cover * 1.25 - 0.45 + weather.rain * 0.6 + weather.fog * 0.6);
    const mix3 = (x: number[], y: number[], out: THREE.Color) => out.setRGB(lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t));
    mix3(a.zen, b.zen, this.zen);
    mix3(a.hor, b.hor, this.hor);
    mix3(a.sun, b.sun, this.sunCol);
    let sunI = lerp(a.sunI, b.sunI, t);
    const amb = lerp(a.amb, b.amb, t);
    // overcast: grey the sky, dim the sun
    const grey = (this.zen.r + this.zen.g + this.zen.b) / 3 * 1.6 + (this.hor.r + this.hor.g + this.hor.b) / 3 * 0.5;
    this.zen.lerp(new THREE.Color(grey * 0.9, grey * 0.95, grey), overcast * 0.85);
    this.hor.lerp(new THREE.Color(grey * 1.05, grey * 1.08, grey * 1.1), overcast * 0.7);
    sunI *= 1 - overcast * 0.82;
    this.night = 1 - smoothstep(-9, 2, el);
    const u = this.mat.uniforms;
    (u.uZenith.value as THREE.Color).copy(this.zen);
    (u.uHorizon.value as THREE.Color).copy(this.hor);
    (u.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(this.moonDir);
    (u.uSunCol.value as THREE.Color).copy(this.sunCol);
    u.uSunI.value = sunI + weather.flash * 6;
    u.uNightF.value = this.night;
    u.uCover.value = clamp(weather.cover, 0, 1) * 0.72 + 0.1;
    u.uOvercast.value = overcast;
    (u.uGround.value as THREE.Color).copy(this.hor).multiplyScalar(0.32).lerp(new THREE.Color(0.03, 0.04, 0.03), 0.4);
    const wind = 0.004 + weather.wind * 0.012;
    this.cloudOff.x += dt * wind;
    this.cloudOff.y += dt * wind * 0.35;

    // --- lights
    const dayLight = sunI > 0.02;
    const lightDir = dayLight ? this.sunDir : this.moonDir;
    // avoid popping when switching between sun and moon
    this.lightDirSmoothed.lerp(lightDir, dayLight ? 1 : clamp01(dt * 1.5)).normalize();
    if (dayLight) {
      this.sun.color.copy(this.sunCol);
      this.sun.intensity = sunI * 1.3;
    } else {
      this.sun.color.setRGB(0.55, 0.68, 1.0);
      this.sun.intensity = 0.22 * this.night * (1 - overcast * 0.7);
    }
    this.sun.intensity += weather.flash * 7;
    this.hemi.color.copy(this.zen).lerp(this.hor, 0.5);
    this.hemi.groundColor.setRGB(0.22, 0.2, 0.16).multiply(this.hor).multiplyScalar(2.2);
    this.hemi.intensity = 0.72 * amb + weather.flash * 2;
    this.scene.environmentIntensity = 0.82;

    // --- fog
    const fog = this.scene.fog as THREE.FogExp2;
    this.fogColor.copy(this.hor).lerp(this.zen, 0.22);
    if (this.night > 0.5) this.fogColor.multiplyScalar(1.15);
    fog.color.copy(this.fogColor);
    const morning = Math.exp(-(((hours - 6.6) / 1.3) ** 2)) * 0.00022;
    fog.density = 0.00013 + morning + weather.rain * 0.0009 + weather.fog * 0.0058 + weather.snow * 0.0012 + overcast * 0.00012;
    U.uFogColor.value.copy(this.fogColor);
    U.uNight.value = this.night;
    U.uSunDir.value.copy(this.lightDirSmoothed);
    U.uSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);

    // --- dome follows the camera
    this.dome.position.copy(camera.position);
    const far = (camera as THREE.PerspectiveCamera).far || 5000;
    this.dome.scale.setScalar(far * 0.9);

    // --- shadow frustum centred on the focus point, snapped to texels
    this.focus.copy(focus);
    const r = this.quality.shadowRadius;
    const sc = this.sun.shadow.camera;
    if (sc.right !== r) {
      sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
      sc.updateProjectionMatrix();
    }
    const dir = this.lightDirSmoothed;
    const texel = (2 * r) / this.sun.shadow.mapSize.x;
    // build light basis
    const up = Math.abs(dir.y) > 0.99 ? _v1.set(1, 0, 0) : _v1.set(0, 1, 0);
    const right = _v2.crossVectors(up, dir).normalize();
    const upL = _v3.crossVectors(dir, right).normalize();
    const fx = Math.round(focus.dot(right) / texel) * texel, fy = Math.round(focus.dot(upL) / texel) * texel, fz = focus.dot(dir);
    const tx = right.x * fx + upL.x * fy + dir.x * fz, ty = right.y * fx + upL.y * fy + dir.y * fz, tz = right.z * fx + upL.z * fy + dir.z * fz;
    this.sun.target.position.set(tx, ty, tz);
    this.sun.position.set(tx + dir.x * 450, ty + dir.y * 450, tz + dir.z * 450);
    this.sun.target.updateMatrixWorld();

    // --- environment map refresh (image based ambient + reflections)
    this.envTimer -= dt;
    const key = `${Math.round(el * 1.5)}|${Math.round(overcast * 12)}|${Math.round(weather.cover * 8)}|${weather.flash > 0.3 ? 1 : 0}`;
    if ((key !== this.lastEnvKey && this.envTimer <= 0) || !this.envRT) {
      this.lastEnvKey = key;
      this.envTimer = 1.5;
      const old = this.envRT;
      this.envMat.uniforms.uDisc.value = 0;
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 1, 200);
      this.scene.environment = this.envRT.texture;
      old?.dispose();
    }
  }

  /** Sky colours for other shaders (water reflections). */
  get zenith(): THREE.Color { return this.zen; }
  get horizon(): THREE.Color { return this.hor; }
  get sunColor(): THREE.Color { return this.sunCol; }
  get sunIntensity(): number { return this.mat.uniforms.uSunI.value as number; }
}
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
