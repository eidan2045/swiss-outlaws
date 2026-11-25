// WebGL renderer, camera and post-processing chain with switchable quality profiles.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { QUALITIES, Quality, QualityName } from './globals';

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.25, 6000);
  quality: Quality;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private ao: GTAOPass | null = null;
  private width = 1;
  private height = 1;
  /** dynamic resolution scale (1 = profile pixel ratio) */
  resScale = 1;
  onResize?: (w: number, h: number) => void;

  constructor(readonly canvas: HTMLCanvasElement, quality: QualityName) {
    this.quality = QUALITIES[quality];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.applyQuality();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(name: QualityName): void {
    this.quality = QUALITIES[name];
    this.applyQuality();
    this.resize();
  }

  private applyQuality(): void {
    const q = this.quality;
    this.renderer.shadowMap.enabled = q.shadows;
    this.camera.far = Math.max(2500, q.viewDist * 1.6);
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    this.ao = null;
    if (q.post) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: q.msaa });
      const composer = new EffectComposer(this.renderer, rt);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (q.ao) {
        const ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.2, thickness: 1.2, scale: 1.1, samples: 8, distanceFallOff: 1, screenSpaceRadius: false });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 8 });
        ao.blendIntensity = 0.85;
        composer.addPass(ao);
        this.ao = ao;
      }
      if (q.bloom) {
        this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.55, 0.92);
        composer.addPass(this.bloom);
      }
      composer.addPass(new OutputPass());
      if (!q.msaa) composer.addPass(new FXAAPass());
      this.composer = composer;
    }
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.width = w;
    this.height = h;
    const pr = Math.min(window.devicePixelRatio || 1, 2) * this.quality.pixelRatio * this.resScale;
    this.renderer.setPixelRatio(Math.max(0.4, Math.min(pr, 2)));
    this.renderer.setSize(w, h, false);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.onResize?.(w, h);
  }

  /** Bloom strength follows the time of day (stronger at night for lamps and windows). */
  setNight(n: number): void {
    if (this.bloom) {
      this.bloom.strength = 0.22 + n * 0.5;
      this.bloom.threshold = 0.98 - n * 0.32;
    }
  }

  render(dt: number): void {
    this.renderer.info.reset();
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
  get size(): { w: number; h: number } {
    return { w: this.width, h: this.height };
  }
}
