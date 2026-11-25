import * as THREE from 'three';
import { buildWorld } from '../shared/world/world';
import { Engine } from './render/engine';
import { WorldView } from './render/worldview';
import type { QualityName } from './render/globals';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game') as HTMLCanvasElement;
document.body.style.cssText = 'margin:0;overflow:hidden;background:#0b0d0f';
canvas.style.cssText = 'display:block;width:100vw;height:100vh';

const engine = new Engine(canvas, (params.get('q') as QualityName) || 'high');
const world = buildWorld();
const view = new WorldView(engine, world);
const cam = engine.camera;
cam.position.set(-150, 60, 520);
cam.lookAt(-100, 10, 0);
const focus = new THREE.Vector3();
let last = performance.now();
let frames = 0;
const dbg = {
  engine, world, view, frames: 0, fps: 0,
  look(x: number, y: number, z: number, tx: number, ty: number, tz: number) {
    cam.position.set(x, y, z);
    cam.lookAt(tx, ty, tz);
  },
};
(window as any).__dbg = dbg;
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  focus.copy(cam.position);
  view.update(dt, focus);
  engine.render(dt);
  dbg.frames = ++frames;
  dbg.fps = 1 / Math.max(dt, 1e-4);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
