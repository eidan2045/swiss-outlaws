import { describe, expect, it, beforeAll } from 'vitest';
import { buildWorld, World } from '../../src/shared/world/world';
import { GameRoom } from '../../src/shared/sim/room';
import { BTN, CharMode, TICK_RATE, emptyInput } from '../../src/shared/sim/types';
import { ServerMsg, decodeSnapshot, newProfile } from '../../src/shared/net/protocol';
import { ACTIVITIES } from '../../src/shared/sim/missions';

let world: World;
beforeAll(() => {
  world = buildWorld();
}, 60000);

function mkRoom() {
  return new GameRoom(world, { code: 'TEST', name: 'Test', private: false, maxPlayers: 8, seed: 42 });
}
function join(room: GameRoom, name: string) {
  const msgs: ServerMsg[] = [];
  let lastSnap: ArrayBuffer | null = null;
  const p = room.addPlayer('acc-' + name, newProfile(name, name.length), (m) => {
    if (m instanceof ArrayBuffer) lastSnap = m;
    else msgs.push(m);
  });
  return { p, msgs, snap: () => decodeSnapshot(lastSnap!) };
}

describe('game room', () => {
  it('runs a living world around a player', { timeout: 60000 }, () => {
    const room = mkRoom();
    const a = join(room, 'Anna');
    expect(a.msgs[0].t).toBe('welcome');
    let seq = 0;
    const t0 = Date.now();
    for (let i = 0; i < TICK_RATE * 40; i++) {
      const inp = emptyInput();
      inp.seq = ++seq;
      inp.mz = -1;
      room.handleInputs(a.p.id, [inp]);
      room.step();
    }
    const ms = Date.now() - t0;
    const s = a.snap();
    let ai = 0, moving = 0, parked = 0;
    for (const v of room.vehicles.values()) {
      if (v.ai) { ai++; if (Math.hypot(v.st.vx, v.st.vz) > 2) moving++; }
      if (v.parked) parked++;
      expect(Number.isFinite(v.st.x + v.st.y + v.st.z + v.st.yaw)).toBe(true);
    }
    console.log(`40 s sim in ${ms} ms (${(ms / (TICK_RATE * 40)).toFixed(3)} ms/tick) – ai ${ai}, moving ${moving}, parked ${parked}, peds ${room.npcs.size}, snapshot ${a.p ? room.snapshot(a.p).byteLength : 0} B`);
    expect(ai).toBeGreaterThan(8);
    expect(moving).toBeGreaterThan(4);
    expect(parked).toBeGreaterThan(5);
    expect(room.npcs.size).toBeGreaterThan(8);
    expect(s.vehicles.length).toBeGreaterThan(10);
    expect(s.ack).toBe(seq);
    // the player walked north from the spawn
    expect(a.p.char.z).toBeLessThan(world.poi('spawn').z - 60);
    // a full tick must stay far below the 16.6 ms budget
    expect(ms / (TICK_RATE * 40)).toBeLessThan(6);
  });

  it('lets a player take a car, drive, and earns a wanted level for crimes', { timeout: 60000 }, () => {
    const room = mkRoom();
    const a = join(room, 'Beat');
    const p = a.p;
    const v = room.spawnVehicle(1, p.char.x + 2.4, p.char.z, Math.PI);
    room.handleCommand(p.id, { k: 'use' });
    expect(p.veh).toBe(v.id);
    expect(p.char.mode).toBe(CharMode.InVehicle);
    let seq = 0, top = 0;
    for (let i = 0; i < TICK_RATE * 3; i++) {
      const inp = emptyInput();
      inp.seq = ++seq;
      inp.mz = 1;
      room.handleInputs(p.id, [inp]);
      room.step();
      top = Math.max(top, Math.hypot(v.st.vx, v.st.vz));
    }
    expect(top).toBeGreaterThan(8);
    expect(a.snap().veh).not.toBeNull();
    room.police.crime(p, 2.5, 'Test');
    expect(p.wanted).toBe(2);
    for (let i = 0; i < TICK_RATE * 12; i++) {
      const inp = emptyInput();
      inp.seq = ++seq;
      inp.buttons = BTN.HANDBRAKE;
      room.handleInputs(p.id, [inp]);
      room.step();
    }
    let pursuit = 0;
    for (const o of room.vehicles.values()) if (o.ai && o.ai.mode === 2 && o.ai.target === p.id) pursuit++;
    expect(pursuit).toBeGreaterThan(0);
    room.handleCommand(p.id, { k: 'use' });
    expect(p.veh).toBe(0);
  });

  it('rejects cheating: money is server-side, inputs are clamped, speed is bounded', { timeout: 60000 }, () => {
    const room = mkRoom();
    const a = join(room, 'Cheater');
    const p = a.p;
    const money = p.profile.money;
    // absurd input values and a flood of inputs
    const flood = [];
    for (let i = 1; i <= 400; i++) flood.push({ seq: i, mx: 50, mz: -50, yaw: 0, pitch: 9, buttons: BTN.SPRINT });
    room.handleInputs(p.id, flood);
    const z0 = p.char.z;
    for (let i = 0; i < TICK_RATE; i++) room.step();
    // at most 2 inputs per tick are consumed → bounded distance in one second
    expect(Math.abs(p.char.z - z0)).toBeLessThan(6.6 * 2 + 1);
    // buying far away from the dealer does nothing
    room.handleCommand(p.id, { k: 'buy', item: 'vehicle', id: 2 });
    expect(p.profile.garage.length).toBe(0);
    expect(p.profile.money).toBe(money);
    // garbage commands do not crash
    room.handleCommand(p.id, { k: 'nope' } as any);
    room.handleCommand(p.id, null as any);
  });

  it('runs the co-op story mission for two players', { timeout: 60000 }, () => {
    const room = mkRoom();
    const a = join(room, 'Anna'), b = join(room, 'Beat');
    const act = ACTIVITIES.find((x) => x.id === 'kurier')!;
    a.p.char.x = act.x; a.p.char.z = act.z; a.p.char.y = world.groundAt(act.x, act.z);
    room.handleCommand(a.p.id, { k: 'mission', op: 'start', id: 'kurier' });
    expect(a.p.mission).not.toBeNull();
    expect(b.p.mission).toBe(a.p.mission);
    const m = a.p.mission!;
    const van = room.vehicles.get(m.vanId)!;
    a.p.char.x = van.st.x + 1.6; a.p.char.z = van.st.z;
    room.handleCommand(a.p.id, { k: 'use' });
    expect(m.step).toBe(2);
    // teleport the van to the pickup, wait for loading
    van.st.x = m.tx; van.st.z = m.tz; van.st.y = world.groundAt(m.tx, m.tz) + van.spec.ride; van.st.vx = van.st.vz = 0;
    for (let i = 0; i < TICK_RATE * 4; i++) room.step();
    expect(m.step).toBe(3);
    van.st.x = m.tx; van.st.z = m.tz; van.st.y = world.groundAt(m.tx, m.tz) + van.spec.ride; van.st.vx = van.st.vz = 0;
    const moneyA = a.p.profile.money, moneyB = b.p.profile.money;
    for (let i = 0; i < TICK_RATE * 2; i++) room.step();
    expect(a.p.mission).toBeNull();
    expect(a.p.profile.money).toBeGreaterThan(moneyA + 1000);
    expect(b.p.profile.money).toBeGreaterThan(moneyB + 1000);
    expect(a.p.profile.missions).toContain('kurier');
    const res = a.msgs.filter((x) => x.t === 'mission').pop() as any;
    expect(res.result.ok).toBe(true);
  });

  it('keeps the avatar for a reconnecting account', () => {
    const room = mkRoom();
    const a = join(room, 'Anna');
    const id = a.p.id;
    a.p.char.x += 10;
    const x = a.p.char.x;
    room.disconnectPlayer(id);
    for (let i = 0; i < TICK_RATE * 3; i++) room.step();
    const again = join(room, 'Anna');
    expect(again.p.id).toBe(id);
    expect(again.p.char.x).toBeCloseTo(x, 3);
    expect(room.players.size).toBe(1);
  });
});
