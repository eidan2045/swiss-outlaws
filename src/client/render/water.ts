// Lake and river surface: animated ripples, sky fresnel reflection, sun glitter, depth-tinted body colour and shore foam.
import * as THREE from 'three';
import { World, ZN, ZRES } from '../../shared/world/world';
import { WORLD_HALF } from '../../shared/world/layout';
import { U } from './globals';
import { makeWaterNormals } from './textures';
import type { SkySystem } from './sky';

const VERT = /* glsl */ `
varying vec3 vWPos;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;
const FRAG = /* glsl */ `
uniform sampler2D tNormal; uniform sampler2D tDepth;
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uCamPos;
uniform float uTime; uniform float uWindAmt; uniform float uNight; uniform float uHalf; uniform float uWet;
varying vec3 vWPos;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 uv = vWPos.xz;
  float dist = distance(vWPos, uCamPos);
  // depth below the surface from the baked terrain texture
  float depth = texture2D(tDepth, (uv + uHalf) / (2.0 * uHalf)).r * 40.0;
  // layered ripples
  vec2 w1 = vec2(uTime * 0.021, uTime * 0.013), w2 = vec2(-uTime * 0.016, uTime * 0.024);
  vec3 n1 = texture2D(tNormal, uv * 0.045 + w1).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(tNormal, uv * 0.13 + w2).xyz * 2.0 - 1.0;
  vec3 n3 = texture2D(tNormal, uv * 0.011 - w1 * 0.4).xyz * 2.0 - 1.0;
  float amp = (0.22 + uWindAmt * 0.5) * (1.0 - smoothstep(300.0, 2500.0, dist) * 0.75);
  vec3 N = normalize(vec3((n1.x + n2.x * 0.6 + n3.x * 0.8) * amp, 1.0, (n1.y + n2.y * 0.6 + n3.y * 0.8) * amp));
  // rain rings (cheap sparkle)
  N.xz += (texture2D(tNormal, uv * 0.9 + vec2(uTime * 0.7, -uTime * 0.5)).xy - 0.5) * uWet * 0.35;
  N = normalize(N);
  vec3 V = normalize(uCamPos - vWPos);
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 sky = mix(uHorizon, uZenith, pow(max(R.y, 0.0), 0.45));
  float sd = max(dot(R, uSunDir), 0.0);
  vec3 sun = uSunColor * (pow(sd, 900.0) * 14.0 + pow(sd, 90.0) * 0.5 + pow(sd, 12.0) * 0.03);
  // body colour: turquoise shallows → deep alpine green-blue
  vec3 shallow = vec3(0.07, 0.3, 0.27), deep = vec3(0.008, 0.07, 0.095);
  float df = 1.0 - exp(-depth * 0.22);
  float light = clamp(dot(uSunColor, vec3(0.2)) * (0.45 + 0.55 * uSunDir.y) + dot(uZenith, vec3(0.5)), 0.0, 1.6);
  vec3 body = mix(shallow, deep, df) * light;
  vec3 col = mix(body, sky, fres) + sun;
  // shore foam
  float foamN = texture2D(tNormal, uv * 0.35 + w2 * 3.0).a;
  float foam = smoothstep(0.55, 0.0, depth) * smoothstep(0.35, 0.75, foamN + 0.25 * sin(uTime * 1.3 + uv.x * 0.4));
  col = mix(col, vec3(0.85, 0.9, 0.92) * (0.25 + light * 0.75), foam * 0.6);
  float alpha = mix(0.5, 0.985, max(df, fres));
  alpha = max(alpha, foam * 0.7);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class Water {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(world: World, private sky: SkySystem) {
    // bake water depth (8 m grid)
    const data = new Uint8Array(ZN * ZN * 4);
    for (let iz = 0; iz < ZN; iz++)
      for (let ix = 0; ix < ZN; ix++) {
        const x = (ix + 0.5) * ZRES - WORLD_HALF, z = (iz + 0.5) * ZRES - WORLD_HALF;
        const d = Math.max(0, -world.visAt(x, z));
        const v = Math.min(255, (d / 40) * 255);
        const k = (iz * ZN + ix) * 4;
        data[k] = v; data[k + 1] = v; data[k + 2] = v; data[k + 3] = 255;
      }
    const depthTex = new THREE.DataTexture(data, ZN, ZN, THREE.RGBAFormat);
    depthTex.magFilter = THREE.LinearFilter;
    depthTex.minFilter = THREE.LinearFilter;
    depthTex.needsUpdate = true;
    const normals = makeWaterNormals(256);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
      transparent: true,
      fog: true,
      depthWrite: false,
    });
    Object.assign(this.mat.uniforms, {
      tNormal: { value: normals }, tDepth: { value: depthTex },
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
      uSunDir: U.uSunDir, uSunColor: U.uSunColor, uCamPos: U.uCamPos, uTime: U.uTime, uWindAmt: { value: 0.3 }, uNight: U.uNight, uHalf: { value: WORLD_HALF }, uWet: U.uWet,
    });
    // the lake continues beyond the playable area towards the southern horizon
    const g = new THREE.PlaneGeometry(WORLD_HALF * 2 + 9000, WORLD_HALF * 2 + 9000, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.position.y = world.waterLevel;
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
  }
  update(wind: number): void {
    (this.mat.uniforms.uZenith.value as THREE.Color).copy(this.sky.zenith);
    (this.mat.uniforms.uHorizon.value as THREE.Color).copy(this.sky.horizon);
    this.mat.uniforms.uWindAmt.value = wind;
  }
}
