// Owns all static world rendering: sky, terrain, water, roads, buildings, scenery.
import * as THREE from 'three';
import type { World } from '../../shared/world/world';
import { Engine } from './engine';
import { SkySystem, WeatherState } from './sky';
import { Terrain } from './terrain';
import { Water } from './water';
import { RoadsView } from './roadsview';
import { BuildingsView } from './buildings';
import { Scenery } from './scenery';
import { uLit } from './facades';
import { U } from './globals';

export class WorldView {
  readonly sky: SkySystem;
  readonly terrain: Terrain;
  readonly water: Water;
  readonly roads: RoadsView;
  readonly buildings: BuildingsView;
  readonly scenery: Scenery;
  weather: WeatherState = { cover: 0.35, rain: 0, fog: 0, snow: 0, wind: 0.3, flash: 0 };
  /** local time of day in hours */
  hours = 10.5;
  /** shared simulation time (seconds) – drives traffic signals */
  simTime = 0;
  /** chunks still waiting to be meshed */
  pending = 0;

  constructor(readonly engine: Engine, readonly world: World) {
    const { scene, renderer, quality } = engine;
    this.sky = new SkySystem(renderer, scene, quality);
    this.terrain = new Terrain(world, quality);
    scene.add(this.terrain.group);
    this.water = new Water(world, this.sky);
    scene.add(this.water.mesh);
    this.roads = new RoadsView(world, quality);
    scene.add(this.roads.group);
    this.buildings = new BuildingsView(world, quality);
    scene.add(this.buildings.group);
    this.scenery = new Scenery(world, quality);
    scene.add(this.scenery.group);
  }

  update(dt: number, focus: THREE.Vector3): void {
    const cam = this.engine.camera;
    const q = this.engine.quality;
    U.uTime.value += dt;
    U.uCamPos.value.copy(cam.position);
    U.uWind.value.set(0.8 + this.weather.wind * 2.2, 0, 0.4 + this.weather.wind);
    // wetness / snow cover follow the weather with inertia
    U.uWet.value += (Math.min(1, this.weather.rain * 1.6) - U.uWet.value) * Math.min(1, dt * 0.25);
    U.uSnow.value += (Math.min(1, this.weather.snow * 1.4) - U.uSnow.value) * Math.min(1, dt * 0.08);
    this.sky.update(this.hours, this.weather, cam, focus, dt);
    // share of lit windows: evening peak, few lights deep in the night
    const h = this.hours;
    uLit.value = h > 17 && h < 23.5 ? 0.62 : h >= 23.5 || h < 1 ? 0.3 : h < 5.5 ? 0.1 : h < 8 ? 0.4 : 0.18;
    this.terrain.update(cam.position);
    this.water.update(this.weather.wind);
    this.roads.update(cam.position, q.viewDist);
    this.pending = this.buildings.update(cam.position, q.viewDist) + this.terrain.pending;
    this.scenery.update(cam.position, this.sky.night, this.simTime, dt);
    this.engine.setNight(this.sky.night);
  }
}
