import { buildWorld } from '../shared/world/world';
import { newProfile } from '../shared/net/protocol';
import { Engine } from './render/engine';
import { WorldView } from './render/worldview';
import type { QualityName } from './render/globals';
import { LoopbackTransport, NetClient } from './net/client';
import { Input } from './input/input';
import { Game } from './game';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game') as HTMLCanvasElement;
document.body.style.cssText = 'margin:0;overflow:hidden;background:#0b0d0f';
canvas.style.cssText = 'display:block;width:100vw;height:100vh';

const engine = new Engine(canvas, (params.get('q') as QualityName) || 'high');
const world = buildWorld();
const view = new WorldView(engine, world);
const input = new Input(canvas);
input.uiMode = false;
const transport = new LoopbackTransport(world, newProfile('Tester', 3), () => {});
const net = new NetClient(world, transport);
const game = new Game(engine, world, view, net, input);
let last = performance.now();
let frames = 0;
const dbg = { engine, world, view, game, net, room: transport.room, input, frames: 0, fps: 0 };
(window as any).__dbg = dbg;
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  game.update(dt);
  engine.render(dt);
  dbg.frames = ++frames;
  dbg.fps = 1 / Math.max(dt, 1e-4);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
