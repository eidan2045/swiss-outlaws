// Traffic: lane-following AI drivers (physics driven), population spawner and parked cars.
import { clamp, dist2, hashInt } from '../math';
import { EdgePos, RoadEdge, edgePos, findRoute, makeNearest } from '../world/roads';
import { signalColor } from '../world/signals';
import { Zone } from '../world/layout';
import { DT, TICK_RATE, VF } from './types';
import { driveTo } from './drive';
import { stepVehicle, vehEvents } from './vehicle';
import type { GameRoom, RoomVehicle } from './room';

export interface TrafficAI {
  edge: number;
  dir: number;
  /** distance travelled along the current edge */
  s: number;
  lane: number;
  next: number;
  speedF: number;
  panic: number;
  stuckT: number;
  waitT: number;
  /** 0 cruise, 1 police patrol, 2 police pursuit */
  mode: number;
  target: number;
  route: number[];
  repathT: number;
  honkT: number;
  reverseT: number;
}

const ep: EdgePos = { x: 0, y: 0, z: 0, tx: 0, tz: 0, flag: 0 };
const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };

export function laneOffset(e: RoadEdge, lane: number): number {
  switch (e.type) {
    case 'highway': return lane === 0 ? 6.35 : 2.75;
    case 'main': return (e.width / 2 - 2.2) / 2 + 0.25;
    case 'street': return e.width / 4;
    case 'alley': return 0.7;
    default: return e.width / 4;
  }
}
/** Point on the lane centre at travel distance s (dir +1 = a→b). */
export function lanePoint(e: RoadEdge, dir: number, s: number, lane: number, out: typeof pt): typeof pt {
  edgePos(e, dir > 0 ? s : e.length - s, ep);
  const tx = ep.tx * dir, tz = ep.tz * dir;
  const off = laneOffset(e, lane);
  out.x = ep.x - tz * off;
  out.z = ep.z + tx * off;
  out.y = ep.y;
  out.tx = tx;
  out.tz = tz;
  return out;
}

export class Traffic {
  private spotVeh = new Map<number, number>();
  private spotGrid = new Map<number, number[]>();
  private nr = makeNearest();
  private spawnT = 0;
  /** multiplier for tests / low-end hosts */
  density = 1;

  constructor(private room: GameRoom) {
    room.world.city.parking.forEach((p, i) => {
      const k = Math.floor((p.x + 2048) / 128) * 64 + Math.floor((p.z + 2048) / 128);
      if (!this.spotGrid.has(k)) this.spotGrid.set(k, []);
      this.spotGrid.get(k)!.push(i);
    });
  }

  newAI(edge: number, dir: number, s: number, lane: number, mode = 0): TrafficAI {
    return { edge, dir, s, lane, next: -1, speedF: this.room.rng.range(0.82, 1.06), panic: 0, stuckT: 0, waitT: 0, mode, target: 0, route: [], repathT: 0, honkT: 0, reverseT: 0 };
  }

  private chooseNext(e: RoadEdge, dir: number, ai: TrafficAI): number {
    const g = this.room.world.roads;
    const node = g.nodes[dir > 0 ? e.b : e.a];
    // pursuit: follow the computed route
    if (ai.mode === 2 && ai.route.length) {
      const want = ai.route[0];
      for (const ei of node.edges) {
        const o = g.edges[ei];
        if ((o.a === node.id ? o.b : o.a) === want && o.type !== 'track') { ai.route.shift(); return ei; }
      }
    }
    const cands: number[] = [];
    let total = 0;
    const weights: number[] = [];
    for (const ei of node.edges) {
      if (ei === e.id) continue;
      const o = g.edges[ei];
      if (o.type === 'alley' || o.type === 'track') continue;
      let w = o.type === e.type ? 3 : 1;
      if (o.type === 'highway' && e.type !== 'highway') w = 0.6;
      // discourage U-turn-like sharp angles
      const od = o.a === node.id ? 1 : -1;
      const i0 = od > 0 ? 0 : o.n - 1, i1 = od > 0 ? Math.min(2, o.n - 1) : Math.max(0, o.n - 3);
      const ox = o.px[i1] - o.px[i0], oz = o.pz[i1] - o.pz[i0];
      const j0 = dir > 0 ? e.n - 1 : 0, j1 = dir > 0 ? Math.max(0, e.n - 3) : Math.min(2, e.n - 1);
      const ix = e.px[j0] - e.px[j1], iz = e.pz[j0] - e.pz[j1];
      const dot = (ox * ix + oz * iz) / ((Math.hypot(ox, oz) || 1) * (Math.hypot(ix, iz) || 1));
      if (dot < -0.6) w *= 0.1;
      cands.push(ei);
      weights.push(w);
      total += w;
    }
    if (!cands.length) return e.id; // dead end: turn around
    let r = this.room.rng.next() * total;
    for (let i = 0; i < cands.length; i++) { r -= weights[i]; if (r <= 0) return cands[i]; }
    return cands[cands.length - 1];
  }

  update(wetGrip: number): void {
    const room = this.room;
    const g = room.world.roads;
    const vehicles = room.vehicles;
    for (const v of vehicles.values()) {
      const ai = v.ai;
      if (!ai || v.driver) continue;
      const st = v.st;
      if (st.flags & VF.WRECKED) { v.ai = null; continue; }
      let e = g.edges[ai.edge];
      const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
      const vf = st.vx * fx + st.vz * fz;
      ai.s += Math.max(0, vf) * DT;
      if (ai.panic > 0) ai.panic -= DT;

      // --- pursuit target bookkeeping
      let pursue: { x: number; z: number; vx: number; vz: number; onFoot: boolean } | null = null;
      if (ai.mode === 2) {
        const tp = room.players.get(ai.target);
        if (!tp || tp.wanted === 0 || !tp.connected) { ai.mode = 1; ai.route.length = 0; st.flags &= ~VF.SIREN; }
        else {
          const tv = tp.veh ? vehicles.get(tp.veh) : undefined;
          pursue = { x: tp.char.x, z: tp.char.z, vx: tv ? tv.st.vx : tp.char.vx, vz: tv ? tv.st.vz : tp.char.vz, onFoot: !tv };
          st.flags |= VF.SIREN | VF.LIGHTS;
        }
      }

      // --- edge transitions
      if (ai.s >= e.length - 0.5) {
        const nextId = ai.next >= 0 ? ai.next : this.chooseNext(e, ai.dir, ai);
        const node = ai.dir > 0 ? e.b : e.a;
        const ne = g.edges[nextId];
        ai.dir = nextId === e.id ? -ai.dir : ne.a === node ? 1 : -1;
        ai.edge = nextId;
        ai.s = 0;
        ai.next = -1;
        e = ne;
        if (e.type !== 'highway') ai.lane = 0;
        else if (ai.lane === 0 && room.rng.chance(0.3)) ai.lane = 1;
      }
      const remain = e.length - ai.s;
      if (ai.next < 0 && remain < 40) ai.next = this.chooseNext(e, ai.dir, ai);

      // --- target point (may lie on the next edge)
      const speed = Math.abs(vf);
      const look = clamp(5 + speed * 0.75, 6, 24);
      let tx: number, tz: number;
      if (look < remain || ai.next < 0 || ai.next === e.id) lanePoint(e, ai.dir, Math.min(e.length, ai.s + look), ai.lane, pt);
      else {
        const ne = g.edges[ai.next];
        const node = ai.dir > 0 ? e.b : e.a;
        lanePoint(ne, ne.a === node ? 1 : -1, Math.min(ne.length, look - remain + 2), ne.type === 'highway' ? ai.lane : 0, pt);
      }
      tx = pt.x; tz = pt.z;

      // --- desired speed
      let limit = e.speed;
      const zone = room.world.zoneAt(st.x, st.z);
      if (e.type === 'street' && (zone === Zone.Residential || zone === Zone.Hillside || zone === Zone.OldTown)) limit = 30 / 3.6;
      let target = limit * ai.speedF * (ai.lane === 1 ? 1.12 : 1);
      if (ai.mode === 2) target = Math.max(target * 1.7, 24);
      else if (ai.panic > 0) target *= 1.45;
      if (wetGrip < 0.9) target *= 0.88;

      const node = g.nodes[ai.dir > 0 ? e.b : e.a];
      const stopDist = remain - 9.5;
      if (ai.mode !== 2 && ai.panic <= 0) {
        if (node.signal) {
          const sig = room.world.city.signals.find((sg) => sg.node === node.id && sg.edge === e.id);
          const col = sig ? signalColor(node.id, sig.phase, room.time) : 2;
          if (col !== 2 && stopDist > -2.5 && stopDist < 70 && !(col === 1 && stopDist < speed * 0.9)) target = Math.min(target, Math.sqrt(Math.max(0, 2 * 2.6 * stopDist)));
        } else if (node.edges.length >= 3 && remain < 26) {
          target = Math.min(target, 6.5);
        }
        // slow for the turn onto the next edge
        if (ai.next >= 0 && ai.next !== e.id && remain < 30) {
          const ne = g.edges[ai.next];
          const nd = ne.a === node.id ? 1 : -1;
          lanePoint(ne, nd, Math.min(ne.length, 8), 0, pt);
          const ax = pt.tx, az = pt.tz;
          lanePoint(e, ai.dir, e.length - 1, ai.lane, pt);
          const dot = ax * pt.tx + az * pt.tz;
          if (dot < 0.82) target = Math.min(target, 4.2 + Math.max(0, dot) * 4 + remain * 0.25);
        }
      }

      // --- obstacles ahead (vehicles, people)
      let lead = 1e9, leadV = 0;
      const lxv = Math.cos(st.yaw), lzv = -Math.sin(st.yaw);
      const reach = 10 + speed * 2.2;
      for (const o of vehicles.values()) {
        if (o === v) continue;
        const dx = o.st.x - st.x, dz = o.st.z - st.z;
        if (Math.abs(dx) > reach + 8 || Math.abs(dz) > reach + 8) continue;
        if (ai.mode === 2 && o.driver === ai.target) continue;
        const ahead = dx * fx + dz * fz, lat = dx * lxv + dz * lzv;
        const gap = ahead - (v.spec.length + o.spec.length) * 0.5;
        if (gap > -1 && gap < reach && Math.abs(lat) < (v.spec.width + o.spec.width) * 0.5 + 0.25 + gap * 0.03) {
          if (gap < lead) { lead = gap; leadV = o.st.vx * fx + o.st.vz * fz; }
        }
      }
      for (const p of room.players.values()) {
        if (p.veh || !p.connected) continue;
        if (ai.mode === 2 && p.id === ai.target) continue;
        const dx = p.char.x - st.x, dz = p.char.z - st.z;
        const ahead = dx * fx + dz * fz, lat = dx * lxv + dz * lzv;
        const gap = ahead - v.spec.length * 0.5;
        if (gap > -0.5 && gap < 6 + speed * 1.3 && Math.abs(lat) < v.spec.width * 0.5 + 0.7) {
          if (gap < lead) { lead = gap; leadV = 0; }
          if (ai.honkT <= 0 && gap < 6) { ai.honkT = 2.5; st.flags |= VF.HORN; }
        }
      }
      if (ai.honkT > 0) { ai.honkT -= DT; if (ai.honkT < 1.9) st.flags &= ~VF.HORN; }
      if (lead < 1e8) target = Math.min(target, Math.max(0, leadV * 0.95 + (lead - 3.2) * 0.7));

      // --- pursuit steering overrides lane following when close
      if (pursue) {
        const d = dist2(st.x, st.z, pursue.x, pursue.z);
        if (d < 55) {
          const lead2 = clamp(d / 22, 0, 1.2);
          tx = pursue.x + pursue.vx * lead2;
          tz = pursue.z + pursue.vz * lead2;
          const tsp = Math.hypot(pursue.vx, pursue.vz);
          target = pursue.onFoot ? (d < 14 ? 0 : 9) : Math.max(tsp + 5, 14);
          if (lead < 6 && !pursue.onFoot) target = Math.min(target, leadV + 2);
          // keep the lane bookkeeping roughly in sync so the unit can resume routing
          ai.repathT -= DT;
          if (ai.repathT <= 0) {
            ai.repathT = 1.5;
            const n = room.world.roadIndex.nearest(st.x, st.z, 30, this.nr, (o) => o.type !== 'track');
            if (n) {
              ai.edge = n.edge.id;
              const dotT = n.edge.px[n.seg + 1] - n.edge.px[n.seg], dotZ = n.edge.pz[n.seg + 1] - n.edge.pz[n.seg];
              ai.dir = dotT * fx + dotZ * fz >= 0 ? 1 : -1;
              ai.s = ai.dir > 0 ? n.s : n.edge.length - n.s;
              ai.next = -1;
            }
          }
        } else {
          ai.repathT -= DT;
          if (ai.repathT <= 0) {
            ai.repathT = 3;
            const tn = room.world.roadIndex.nearest(pursue.x, pursue.z, 120, this.nr, (o) => o.type !== 'track');
            if (tn) {
              const goal = tn.t < 0.5 ? tn.edge.a : tn.edge.b;
              const from = ai.dir > 0 ? e.b : e.a;
              ai.route = findRoute(g, from, goal).slice(1);
              ai.next = -1;
            }
          }
        }
      }

      // --- stuck handling
      if (target > 2 && speed < 0.35) ai.stuckT += DT;
      else if (speed > 1.5) ai.stuckT = Math.max(0, ai.stuckT - DT * 3);
      if (ai.stuckT > 5 && ai.reverseT <= 0 && lead > 2) { ai.reverseT = 1.6; ai.stuckT = 2; }
      if (ai.reverseT > 0) {
        ai.reverseT -= DT;
        driveTo(st, v.spec, tx, tz, -3, v.inp);
      } else driveTo(st, v.spec, tx, tz, target, v.inp);
      if (this.room.hours > 20.2 || this.room.hours < 6.6 || this.room.weather.rain > 0.4 || room.world.inTunnel(st.x, st.z, st.y)) st.flags |= VF.LIGHTS;
      else if (ai.mode !== 2) st.flags &= ~VF.LIGHTS;
      st.flags |= VF.ENGINE;
    }

    // --- population
    this.spawnT -= DT;
    if (this.spawnT <= 0) {
      this.spawnT = 0.2;
      this.populate();
    }
  }

  private populate(): void {
    const room = this.room, world = room.world;
    const players = [...room.players.values()].filter((p) => p.connected);
    if (!players.length) return;
    const night = room.hours < 5.5 || room.hours > 22.5 ? 0.35 : room.hours < 7 || room.hours > 20 ? 0.65 : 1;
    // despawn far vehicles
    for (const v of room.vehicles.values()) {
      if (v.driver || v.passengers.length || v.owner || v.cargo) continue;
      let near = 1e9;
      for (const p of players) near = Math.min(near, dist2(v.st.x, v.st.z, p.char.x, p.char.z));
      const limit = v.ai ? (v.ai.mode === 2 ? 520 : 360) : v.spot >= 0 ? 330 : 240;
      if (near > limit || (v.ai && v.ai.stuckT > 22 && near > 60) || (v.st.flags & VF.WATER && near > 40)) {
        if (v.spot >= 0) this.spotVeh.delete(v.spot);
        room.removeVehicle(v);
      }
    }
    for (const p of players) {
      const c = p.char;
      const zone = world.zoneAt(c.x, c.z);
      const base = zone === Zone.Downtown || zone === Zone.OldTown || zone === Zone.Business ? 22 : zone === Zone.Residential || zone === Zone.Industrial || zone === Zone.Station ? 16 : zone === Zone.Hillside || zone === Zone.Village ? 9 : 7;
      const want = Math.round(base * night * this.density);
      let have = 0;
      for (const v of room.vehicles.values()) if (v.ai && dist2(v.st.x, v.st.z, c.x, c.z) < 330) have++;
      if (have < want && room.vehicles.size < 150) {
        for (let tries = 0; tries < 3; tries++) {
          const a = room.rng.next() * Math.PI * 2, d = room.rng.range(150, 290);
          const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
          const n = world.roadIndex.nearest(x, z, 70, this.nr, (o) => o.type !== 'alley' && o.type !== 'track');
          if (!n || n.edge.flag[n.seg] === 2) continue;
          const e = n.edge;
          const dir = room.rng.chance(0.5) ? 1 : -1;
          const s = clamp(dir > 0 ? n.s : e.length - n.s, 2, e.length - 2);
          const lane = e.type === 'highway' && room.rng.chance(0.35) ? 1 : 0;
          lanePoint(e, dir, s, lane, pt);
          let ok = true;
          for (const o of players) if (dist2(pt.x, pt.z, o.char.x, o.char.z) < 120) ok = false;
          if (ok) for (const o of room.vehicles.values()) if (dist2(pt.x, pt.z, o.st.x, o.st.z) < 14) { ok = false; break; }
          if (!ok) continue;
          const r = room.rng.next();
          let spec = r < 0.34 ? 0 : r < 0.6 ? 1 : r < 0.76 ? 3 : r < 0.88 ? 4 : r < 0.93 ? 2 : r < 0.965 ? 5 : 6;
          if (spec === 6 && e.type !== 'main') spec = 0;
          const v = room.spawnVehicle(spec, pt.x, pt.z, Math.atan2(pt.tx, pt.tz));
          v.st.y = pt.y + v.spec.ride;
          v.ai = this.newAI(e.id, dir, s, lane, spec === 5 ? 1 : 0);
          const sp = e.speed * 0.6;
          v.st.vx = pt.tx * sp; v.st.vz = pt.tz * sp;
          v.st.flags |= VF.ENGINE;
          break;
        }
      }
      // parked cars
      const gx = Math.floor((c.x + 2048) / 128), gz = Math.floor((c.z + 2048) / 128);
      const spots = world.city.parking;
      let budget = 3;
      for (let ox = -2; ox <= 2 && budget > 0; ox++)
        for (let oz = -2; oz <= 2 && budget > 0; oz++) {
          const list = this.spotGrid.get((gx + ox) * 64 + gz + oz);
          if (!list) continue;
          for (const i of list) {
            if (this.spotVeh.has(i)) continue;
            const sp = spots[i];
            const d = dist2(sp.x, sp.z, c.x, c.z);
            if (d > 260 || d < 45) continue;
            const h = (hashInt(i * 2654435761) % 1000) / 1000;
            if (h > (sp.lot ? 0.72 : 0.52) * Math.min(1, this.density + 0.2)) { this.spotVeh.set(i, -1); continue; }
            const r = (hashInt(i * 40503 + 17) % 100) / 100;
            const spec = r < 0.4 ? 0 : r < 0.68 ? 1 : r < 0.84 ? 3 : r < 0.94 ? 4 : 2;
            const v = room.spawnVehicle(spec, sp.x, sp.z, sp.yaw, hashInt(i * 7 + 3) % 16);
            v.parked = true;
            v.spot = i;
            v.st.flags &= ~VF.ENGINE;
            this.spotVeh.set(i, v.id);
            if (--budget <= 0) break;
          }
        }
    }
    void TICK_RATE; void stepVehicle; void vehEvents;
  }

  /** Spawn a police pursuit unit on a road near (x,z). */
  spawnPursuit(targetId: number, x: number, z: number): RoomVehicle | null {
    const room = this.room, world = room.world;
    for (let tries = 0; tries < 8; tries++) {
      const a = room.rng.next() * Math.PI * 2, d = room.rng.range(130, 230);
      const n = world.roadIndex.nearest(x + Math.cos(a) * d, z + Math.sin(a) * d, 80, this.nr, (o) => o.type !== 'alley' && o.type !== 'track');
      if (!n || n.edge.flag[n.seg] === 2) continue;
      const e = n.edge;
      // head towards the target
      const toA = dist2(world.roads.nodes[e.a].x, world.roads.nodes[e.a].z, x, z), toB = dist2(world.roads.nodes[e.b].x, world.roads.nodes[e.b].z, x, z);
      const dir = toB < toA ? 1 : -1;
      const s = clamp(dir > 0 ? n.s : e.length - n.s, 2, e.length - 2);
      lanePoint(e, dir, s, 0, pt);
      let ok = true;
      for (const o of room.players.values()) if (dist2(pt.x, pt.z, o.char.x, o.char.z) < 90) ok = false;
      for (const o of room.vehicles.values()) if (dist2(pt.x, pt.z, o.st.x, o.st.z) < 12) { ok = false; break; }
      if (!ok) continue;
      const v = room.spawnVehicle(5, pt.x, pt.z, Math.atan2(pt.tx, pt.tz));
      v.st.y = pt.y + v.spec.ride;
      v.ai = this.newAI(e.id, dir, s, 0, 2);
      v.ai.target = targetId;
      v.st.vx = pt.tx * 12; v.st.vz = pt.tz * 12;
      v.st.flags |= VF.ENGINE | VF.SIREN | VF.LIGHTS;
      return v;
    }
    return null;
  }
}
