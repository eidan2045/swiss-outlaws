import { describe, expect, it, beforeAll } from 'vitest';
import { buildWorld, World } from '../../src/shared/world/world';
import { BTN, CF, DT, VEHICLES, emptyInput, newChar, newVeh } from '../../src/shared/sim/types';
import { stepCharacter } from '../../src/shared/sim/character';
import { stepVehicle, VehInput } from '../../src/shared/sim/vehicle';
import { driveTo } from '../../src/shared/sim/drive';
import { edgePos, makeNearest } from '../../src/shared/world/roads';

let world: World;
beforeAll(() => {
  world = buildWorld();
}, 60000);

describe('world', () => {
  it('is deterministic and connected', { timeout: 60000 }, () => {
    expect(world.roads.nodes.length).toBeGreaterThan(200);
    expect(world.city.buildings.length).toBeGreaterThan(1500);
    const w2 = buildWorld();
    expect(w2.height[123456]).toBe(world.height[123456]);
    expect(w2.city.buildings.length).toBe(world.city.buildings.length);
    expect(w2.city.buildings[777].x).toBe(world.city.buildings[777].x);
    // every road node reachable from node 0
    const seen = new Set<number>([0]);
    const stack = [0];
    while (stack.length) {
      const n = stack.pop()!;
      for (const ei of world.roads.nodes[n].edges) {
        const e = world.roads.edges[ei];
        const o = e.a === n ? e.b : e.a;
        if (!seen.has(o)) { seen.add(o); stack.push(o); }
      }
    }
    expect(seen.size).toBe(world.roads.nodes.length);
  });
});

describe('character', () => {
  it('jogs, sprints and jumps plausibly', () => {
    const sp = world.poi('spawn');
    const c = newChar(sp.x, world.groundAt(sp.x, sp.z), sp.z);
    const inp = emptyInput();
    inp.mz = -1; // north along Bahnhofstrasse
    for (let i = 0; i < 180; i++) stepCharacter(c, inp, world, DT);
    const jog = Math.hypot(c.vx, c.vz);
    expect(jog).toBeGreaterThan(3.2);
    expect(jog).toBeLessThan(4.2);
    inp.buttons = BTN.SPRINT;
    for (let i = 0; i < 120; i++) stepCharacter(c, inp, world, DT);
    expect(Math.hypot(c.vx, c.vz)).toBeGreaterThan(5.8);
    const y0 = c.y;
    inp.buttons = BTN.JUMP;
    stepCharacter(c, inp, world, DT);
    let maxY = c.y;
    inp.buttons = 0;
    for (let i = 0; i < 90; i++) { stepCharacter(c, inp, world, DT); maxY = Math.max(maxY, c.y); }
    expect(maxY - y0).toBeGreaterThan(0.7);
    expect(maxY - y0).toBeLessThan(1.6);
    expect(c.flags & CF.GROUND).toBeTruthy();
    expect(Number.isFinite(c.x + c.y + c.z)).toBe(true);
  });
  it('swims in the lake instead of sinking', () => {
    const c = newChar(0, -5, 700);
    const inp = emptyInput();
    for (let i = 0; i < 240; i++) stepCharacter(c, inp, world, DT);
    expect(c.flags & CF.SWIM).toBeTruthy();
    expect(c.y).toBeGreaterThan(-1.6);
    expect(c.y).toBeLessThan(-1.0);
  });
});

describe('vehicle', () => {
  const run = (specId: number) => {
    const spec = VEHICLES[specId];
    // straight motorway stretch, drive in the right-hand lane
    const nr = makeNearest();
    const near = world.roadIndex.nearest(-1100, -1068, 80, nr, (e) => e.type === 'highway')!;
    const e = near.edge;
    const ep = { x: 0, y: 0, z: 0, tx: 0, tz: 0, flag: 0 };
    const lane = (s: number) => {
      edgePos(e, s, ep);
      return { x: ep.x - ep.tz * 2.7, z: ep.z + ep.tx * 2.7, y: ep.y, yaw: Math.atan2(ep.tx, ep.tz) };
    };
    let s = near.s;
    const st = lane(s);
    const v = newVeh(st.x, st.y + spec.ride, st.z, st.yaw);
    const inp: VehInput = { steer: 0, throttle: 1, handbrake: false };
    let t100 = -1, top = 0;
    for (let k = 0; k < 60 * 22; k++) {
      const sp = Math.hypot(v.vx, v.vz);
      s += sp * DT;
      const tgt = lane(Math.min(e.length - 1, s + 12 + sp * 0.5));
      driveTo(v, spec, tgt.x, tgt.z, 200, inp);
      inp.throttle = 1;
      stepVehicle(v, spec, inp, world, DT);
      top = Math.max(top, sp);
      if (t100 < 0 && sp >= 27.78) t100 = (k + 1) * DT;
      if (s > e.length - 160) break;
    }
    const vBrake = Math.hypot(v.vx, v.vz);
    inp.throttle = -1;
    inp.steer = 0;
    let dist = 0, tb = 0;
    while (Math.hypot(v.vx, v.vz) > 1.5 && tb < 20) {
      stepVehicle(v, spec, inp, world, DT);
      dist += Math.hypot(v.vx, v.vz) * DT;
      tb += DT;
    }
    return { name: spec.name, t100: +t100.toFixed(2), topKmh: Math.round(top * 3.6), vBrake: Math.round(vBrake * 3.6), brakeDist: Math.round(dist), decel: +(vBrake / tb).toFixed(1), finite: Number.isFinite(v.x + v.y + v.z + v.yaw) };
  };
  it('accelerates, reaches a sane top speed and brakes', () => {
    const rows = [0, 1, 2, 3, 4, 5].map(run);
    console.table(rows);
    for (const r of rows) {
      expect(r.finite).toBe(true);
      expect(r.t100).toBeGreaterThan(2.5);
      expect(r.t100).toBeLessThan(16);
      expect(r.topKmh).toBeGreaterThan(100);
      expect(r.topKmh).toBeLessThan(340);
      expect(r.decel).toBeGreaterThan(6);
    }
    // the sports car must be clearly quicker than the van
    expect(rows[2].t100).toBeLessThan(rows[4].t100 * 0.6);
  });
});
