// Shared render state: global shader uniforms and graphics quality profiles.
import * as THREE from 'three';

export const U = {
  uTime: { value: 0 },
  /** 0 dry .. 1 soaked */
  uWet: { value: 0 },
  /** 0 none .. 1 snow cover */
  uSnow: { value: 0 },
  /** 0 day .. 1 night (drives window / lamp emissive) */
  uNight: { value: 0 },
  uWind: { value: new THREE.Vector3(1, 0, 0.3) },
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },
  uCamPos: { value: new THREE.Vector3() },
  uFogColor: { value: new THREE.Color(0.7, 0.8, 0.9) },
};

export type QualityName = 'low' | 'medium' | 'high' | 'ultra';
export interface Quality {
  name: QualityName;
  pixelRatio: number;
  shadows: boolean;
  shadowSize: number;
  shadowRadius: number;
  post: boolean;
  bloom: boolean;
  ao: boolean;
  msaa: number;
  viewDist: number;
  terrainLod: number; // distance multiplier
  treeNear: number;
  treeFar: number;
  grass: number;
  detailDist: number;
  maxLights: number;
  anisotropy: number;
  reflections: boolean;
}
export const QUALITIES: Record<QualityName, Quality> = {
  low: { name: 'low', pixelRatio: 0.7, shadows: false, shadowSize: 1024, shadowRadius: 70, post: false, bloom: false, ao: false, msaa: 0, viewDist: 1100, terrainLod: 0.6, treeNear: 60, treeFar: 420, grass: 0, detailDist: 120, maxLights: 2, anisotropy: 2, reflections: false },
  medium: { name: 'medium', pixelRatio: 1, shadows: true, shadowSize: 2048, shadowRadius: 110, post: true, bloom: true, ao: false, msaa: 0, viewDist: 1900, terrainLod: 0.85, treeNear: 100, treeFar: 800, grass: 0.5, detailDist: 220, maxLights: 4, anisotropy: 4, reflections: false },
  high: { name: 'high', pixelRatio: 1.25, shadows: true, shadowSize: 4096, shadowRadius: 170, post: true, bloom: true, ao: false, msaa: 4, viewDist: 3000, terrainLod: 1, treeNear: 150, treeFar: 1300, grass: 1, detailDist: 320, maxLights: 6, anisotropy: 8, reflections: false },
  ultra: { name: 'ultra', pixelRatio: 2, shadows: true, shadowSize: 4096, shadowRadius: 230, post: true, bloom: true, ao: true, msaa: 4, viewDist: 4600, terrainLod: 1.4, treeNear: 220, treeFar: 2000, grass: 1.6, detailDist: 480, maxLights: 8, anisotropy: 16, reflections: true },
};

/** Patch a standard material's shader, keeping a stable program cache key. */
export function patchMaterial(mat: THREE.Material, key: string, patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  mat.onBeforeCompile = (shader) => {
    patch(shader);
  };
  mat.customProgramCacheKey = () => key;
}

export function replaceOnce(src: string, find: string, repl: string): string {
  if (!src.includes(find)) console.warn('[shader patch] chunk not found:', find);
  return src.replace(find, repl);
}
