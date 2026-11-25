// Pedestrians: sidewalk walkers with simple reactions (flee, cower, get knocked down).
import { clamp, dist2 } from '../math';
import { EdgePos, RoadEdge, edgePos, makeNearest } from '../world/roads';
import { Zone } from '../world/layout';
import { circleVsCollider, Collider } from '../world/colliders';
import { DT, GRAVITY } from './types';
import type { GameRoom, RoomNpc, RoomPlayer, RoomVehicle } from './room';

const ep: EdgePos = { x: 0, y: 0, z: 0, tx: 0, tz: 0, flag: 0 };
export const NPC = { IDLE: 0, WALK: 1, RUN: 2, KNOCKED: 3, DEAD: 4, AIM: 5, COWER: 6 } as const;

export class Peds {
  private nr = makeNearest();
  private spawnT = 0;
  private tmp: Collider[] = [];
  private hit = [0, 0, 0, 0];
  density = 1;
  constructor(private room: GameRoom) {}

  private walkOffset(e: RoadEdge): number {
    return e.sidewalk > 0 ? e.width / 2 + e.sidewalk * 0.5 : e.type === 'alley' ? e.width / 2 - 1.0 : e.width / 2 + 0.8;
  }
  private place(n: RoomNpc): void {
    const e = this.room.world.roads.edges[n.edge];
    edgePos(e, n.dir > 0 ? n.s : e.length - n.s, ep);
    const tx = ep.tx * n.dir, tz = ep.tz * n.dir;
    const off = this.walkOffset(e) * n.side;
    n.x = ep.x - tz * off;
    n.z = ep.z + tx * off;
    n.y = this.room.world.groundAt(n.x, n.z, ep.y + 2);
    n.yaw = Math.atan2(tx, tz);
  }
  private make(kind: number, x: number, y: number, z: number): RoomNpc {
    const room = this.room;
    const n: RoomNpc = { id: room.nextNpcId(), kind, x, y, z, yaw: 0, vx: 0, vy: 0, vz: 0, state: NPC.WALK, stateT: 0, look: room.rng.int(0, 65535), speed: 0, hp: 100, edge: 0, dir: 1, s: 0, side: 1, target: 0, fireT: 0, fleeX: 0, fleeZ: 0 };
    room.npcs.set(n.id, n);
    return n;
  }

  spawnFleeing(x: number, z: number, fromX: number, fromZ: number): void {
    const world = this.room.world;
    const r = world.roadIndex.nearest(x, z, 40, this.nr, (o) => o.type !== 'track' && o.type !== 'highway');
    const n = this.make(0, x, world.groundAt(x, z), z);
    if (r) { n.edge = r.edge.id; n.s = r.s; n.side = r.side; n.dir = 1; }
    n.state = NPC.RUN;
    n.stateT = 14;
    n.fleeX = fromX; n.fleeZ = fromZ;
    n.edge = r ? r.edge.id : -1;
  }
  /** Police officer on foot (controlled by the police system). */
  spawnCop(x: number, z: number, target: number): RoomNpc {
    const n = this.make(1, x, this.room.world.groundAt(x, z), z);
    n.edge = -1;
    n.target = target;
    n.state = NPC.RUN;
    n.hp = 140;
    return n;
  }

  scare(x: number, z: number, radius: number, _by: RoomPlayer | null): void {
    for (const n of this.room.npcs.values()) {
      if (n.kind !== 0 || n.state === NPC.DEAD || n.state === NPC.KNOCKED) continue;
      if (dist2(n.x, n.z, x, z) < radius) {
        n.state = this.room.rng.chance(0.2) && dist2(n.x, n.z, x, z) < 12 ? NPC.COWER : NPC.RUN;
        n.stateT = this.room.rng.range(8, 15);
        n.fleeX = x; n.fleeZ = z;
      }
    }
  }
  damage(n: RoomNpc, dmg: number, by: RoomPlayer | null, dx: number, dz: number): void {
    if (n.state === NPC.DEAD) return;
    n.hp -= dmg;
    n.vx = dx * 3; n.vz = dz * 3; n.vy = 2.2;
    n.state = NPC.KNOCKED;
    n.stateT = 2.4;
    if (n.hp <= 0) { n.state = NPC.DEAD; n.stateT = 45; }
    if (by) {
      if (n.kind === 1) this.room.police.crime(by, n.hp <= 0 ? 3.5 : 2, 'Angriff auf die Polizei');
      else this.room.police.crime(by, n.hp <= 0 ? 2.4 : 1.0, n.hp <= 0 ? 'Tötungsdelikt' : 'Körperverletzung');
    }
    this.scare(n.x, n.z, 24, by);
  }
  hitByVehicle(n: RoomNpc, v: RoomVehicle, speed: number, driver: RoomPlayer | null): void {
    const dmg = Math.max(0, speed - 2.5) * 8;
    n.hp -= dmg;
    n.vx = v.st.vx * 0.85; n.vz = v.st.vz * 0.85; n.vy = 2 + speed * 0.14;
    n.state = NPC.KNOCKED;
    n.stateT = 3;
    if (n.hp <= 0) { n.state = NPC.DEAD; n.stateT = 45; }
    if (driver) {
      if (n.kind === 1) this.room.police.crime(driver, 2.6, 'Polizist angefahren');
      else this.room.police.crime(driver, n.hp <= 0 ? 2.2 : 1.1, n.hp <= 0 ? 'Fahrlässige Tötung' : 'Personenschaden');
    }
    this.scare(n.x, n.z, 20, driver);
    this.room.broadcastNear({ t: 'fx', kind: 'punch', x: n.x, y: n.y + 1, z: n.z }, n.x, n.z, 70);
  }

  private collide(n: RoomNpc): void {
    const world = this.room.world;
    world.colliders.query(n.x, n.z, 1, this.tmp);
    for (const c of this.tmp) {
      if (c.y1 < n.y + 0.4 || c.y0 > n.y + 1.7) continue;
      if (circleVsCollider(n.x, n.z, 0.32, c, this.hit)) { n.x += this.hit[0]; n.z += this.hit[1]; }
    }
  }

  update(): void {
    const room = this.room, world = room.world;
    const g = world.roads;
    for (const n of room.npcs.values()) {
      n.stateT -= DT;
      if (n.state === NPC.DEAD) {
        n.speed = 0;
        this.ballistic(n);
        if (n.stateT <= 0) room.npcs.delete(n.id);
        continue;
      }
      if (n.state === NPC.KNOCKED) {
        this.ballistic(n);
        n.speed = Math.hypot(n.vx, n.vz);
        if (n.stateT <= 0 && n.speed < 0.3) {
          n.state = n.kind === 1 ? NPC.RUN : NPC.RUN;
          n.stateT = 10;
          this.snapToRoad(n);
        }
        continue;
      }
      if (n.kind === 1) continue; // officers are driven by the police system
      if (n.state === NPC.COWER) {
        n.speed = 0;
        if (n.stateT <= 0) { n.state = NPC.WALK; }
        continue;
      }
      if (n.edge < 0) { this.snapToRoad(n); if (n.edge < 0) { room.npcs.delete(n.id); continue; } }
      const e = g.edges[n.edge];
      if (n.state === NPC.IDLE) {
        n.speed = 0;
        if (n.stateT <= 0) n.state = NPC.WALK;
        continue;
      }
      let sp = n.state === NPC.RUN ? 4.9 : 1.25 + ((n.look & 15) / 15) * 0.4;
      if (n.state === NPC.RUN) {
        // run away from the threat along the sidewalk
        edgePos(e, n.dir > 0 ? n.s : e.length - n.s, ep);
        const away = (n.x - n.fleeX) * ep.tx * n.dir + (n.z - n.fleeZ) * ep.tz * n.dir;
        if (away < 0 && n.stateT > 0) { n.dir = -n.dir; n.s = e.length - n.s; }
        if (n.stateT <= 0) n.state = NPC.WALK;
      } else if (room.rng.chance(0.0006)) {
        n.state = NPC.IDLE;
        n.stateT = room.rng.range(2, 7);
      }
      // wait for players standing in the way
      n.speed = sp;
      n.s += sp * DT;
      if (n.s >= e.length - 1.5) {
        const node = g.nodes[n.dir > 0 ? e.b : e.a];
        const cands = node.edges.filter((ei) => ei !== e.id && g.edges[ei].type !== 'highway' && g.edges[ei].type !== 'track');
        if (!cands.length) { n.dir = -n.dir; n.s = 1.5; }
        else {
          const ne = g.edges[cands[room.rng.int(0, cands.length - 1)]];
          n.edge = ne.id;
          n.dir = ne.a === node.id ? 1 : -1;
          n.s = Math.min(ne.length * 0.4, 3);
          if (room.rng.chance(0.3)) n.side = -n.side;
        }
      }
      const ox = n.x, oz = n.z;
      this.place(n);
      // smooth the corner jumps
      const jump = dist2(ox, oz, n.x, n.z);
      if (jump > sp * DT * 3 && jump < 14) {
        const k = (sp * DT * 2.2) / jump;
        const tx = n.x, tz = n.z;
        n.x = ox + (tx - ox) * k;
        n.z = oz + (tz - oz) * k;
        n.yaw = Math.atan2(tx - ox, tz - oz);
        n.y = world.groundAt(n.x, n.z, n.y + 2);
        n.s -= sp * DT;
      }
    }
    this.spawnT -= DT;
    if (this.spawnT <= 0) {
      this.spawnT = 0.3;
      this.populate();
    }
  }

  private ballistic(n: RoomNpc): void {
    const world = this.room.world;
    const gnd = world.groundAt(n.x, n.z, n.y + 1);
    if (n.y > gnd + 0.02 || n.vy > 0) {
      n.vy -= GRAVITY * DT;
      n.y += n.vy * DT;
    }
    if (n.y <= gnd) {
      n.y = gnd;
      n.vy = 0;
      const f = Math.max(0, 1 - DT * 4.5);
      n.vx *= f; n.vz *= f;
    }
    n.x += n.vx * DT;
    n.z += n.vz * DT;
    this.collide(n);
    n.x = clamp(n.x, -world.half + 4, world.half - 4);
    n.z = clamp(n.z, -world.half + 4, world.half - 4);
  }
  private snapToRoad(n: RoomNpc): void {
    const r = this.room.world.roadIndex.nearest(n.x, n.z, 40, this.nr, (o) => o.type !== 'track' && o.type !== 'highway');
    if (!r) { n.edge = -1; return; }
    n.edge = r.edge.id;
    n.dir = 1;
    n.s = r.s;
    n.side = r.side;
  }

  private populate(): void {
    const room = this.room, world = room.world;
    const players = [...room.players.values()].filter((p) => p.connected);
    const night = room.hours < 5.5 || room.hours > 23 ? 0.2 : room.hours < 7 || room.hours > 21 ? 0.55 : 1;
    const rain = 1 - room.weather.rain * 0.6;
    for (const n of room.npcs.values()) {
      let near = 1e9;
      for (const p of players) near = Math.min(near, dist2(n.x, n.z, p.char.x, p.char.z));
      if (near > (n.kind === 1 ? 260 : 175)) room.npcs.delete(n.id);
    }
    for (const p of players) {
      const c = p.char;
      const zone = world.zoneAt(c.x, c.z);
      const base = zone === Zone.OldTown || zone === Zone.Downtown ? 26 : zone === Zone.Business || zone === Zone.Station || zone === Zone.Park ? 16 : zone === Zone.Residential ? 10 : zone === Zone.Village ? 8 : zone === Zone.Hillside || zone === Zone.Industrial ? 5 : 1;
      const want = Math.round(base * night * rain * this.density);
      let have = 0;
      for (const n of room.npcs.values()) if (n.kind === 0 && dist2(n.x, n.z, c.x, c.z) < 150) have++;
      if (have >= want || room.npcs.size > 140) continue;
      for (let tries = 0; tries < 4; tries++) {
        const a = room.rng.next() * Math.PI * 2, d = room.rng.range(have < want * 0.4 ? 28 : 55, 125);
        const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
        const r = world.roadIndex.nearest(x, z, 40, this.nr, (o) => o.type !== 'track' && o.type !== 'highway' && o.type !== 'rural');
        if (!r || r.edge.flag[r.seg]) continue;
        const zn = world.zoneAt(r.edge.px[r.seg], r.edge.pz[r.seg]);
        if (zn === Zone.Forest || zn === Zone.Rural || zn === Zone.Alpine) continue;
        const n = this.make(0, 0, 0, 0);
        n.edge = r.edge.id;
        n.dir = room.rng.chance(0.5) ? 1 : -1;
        n.s = clamp(n.dir > 0 ? r.s : r.edge.length - r.s, 2, r.edge.length - 2);
        n.side = room.rng.chance(0.5) ? 1 : -1;
        this.place(n);
        let ok = true;
        for (const o of players) if (dist2(n.x, n.z, o.char.x, o.char.z) < 24) ok = false;
        if (!ok) room.npcs.delete(n.id);
        break;
      }
    }
  }
}
