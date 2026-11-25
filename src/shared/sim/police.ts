// Wanted system: crimes raise heat → stars; police units pursue, arrest or open fire; evading clears the level.
import { angleDiff, clamp, dist2 } from '../math';
import { CharMode, DT, VF } from './types';
import { circleVsCollider, Collider } from '../world/colliders';
import { NPC } from './peds';
import type { GameRoom, RoomNpc, RoomPlayer } from './room';

const STARS = [0.9, 2.3, 4.2, 6.8, 10];
const UNITS = [0, 1, 2, 3, 4, 6];
export const POLICE_STATION = { x: -150, z: -84 };

export class Police {
  private tickT = 0;
  private lastShotReport = new Map<number, number>();
  private arrestT = new Map<number, number>();
  private tmp: Collider[] = [];
  private hit = [0, 0, 0, 0];
  constructor(private room: GameRoom) {}

  starsFor(heat: number): number {
    let s = 0;
    for (const t of STARS) if (heat >= t) s++;
    return s;
  }
  crime(p: RoomPlayer, heat: number, reason: string): void {
    if (p.char.mode === CharMode.Dead) return;
    const before = p.wanted;
    p.heat = Math.min(12, p.heat + heat);
    p.wanted = this.starsFor(p.heat);
    p.unseen = 0;
    if (p.wanted > before) this.room.toast(p, `Fahndungsstufe ${p.wanted} · ${reason}`, 'bad');
  }
  gunfire(p: RoomPlayer, _x: number, _z: number): void {
    const last = this.lastShotReport.get(p.id) ?? -99;
    if (this.room.time - last < 2.5) return;
    this.lastShotReport.set(p.id, this.room.time);
    this.crime(p, 1.15, 'Schusswaffengebrauch');
  }
  clear(p: RoomPlayer): void {
    p.heat = 0;
    p.wanted = 0;
    p.unseen = 99;
    this.arrestT.delete(p.id);
  }

  update(): void {
    const room = this.room;
    // officers on foot move every tick
    for (const n of room.npcs.values()) if (n.kind === 1 && n.state !== NPC.DEAD && n.state !== NPC.KNOCKED) this.officer(n);
    this.tickT -= DT;
    if (this.tickT > 0) return;
    this.tickT = 0.5;
    for (const p of room.players.values()) {
      if (!p.connected) continue;
      if (p.wanted === 0) {
        if (p.heat > 0) p.heat = Math.max(0, p.heat - 0.02);
        continue;
      }
      const c = p.char;
      // who can see the suspect?
      let units = 0, seen = false, closest = 1e9;
      for (const v of room.vehicles.values()) {
        if (!v.police || !v.ai) continue;
        const d = dist2(v.st.x, v.st.z, c.x, c.z);
        if (v.ai.mode === 2 && v.ai.target === p.id) {
          units++;
          closest = Math.min(closest, d);
          if (d < 95) seen = true;
          // unit has caught up with a suspect on foot / in a stopped car: officers step out
          const tv = p.veh ? room.vehicles.get(p.veh) : undefined;
          const tSpeed = tv ? Math.hypot(tv.st.vx, tv.st.vz) : Math.hypot(c.vx, c.vz);
          if (d < 20 && tSpeed < 5 && Math.hypot(v.st.vx, v.st.vz) < 3) {
            let cops = 0;
            for (const n of room.npcs.values()) if (n.kind === 1 && n.target === p.id && n.state !== NPC.DEAD) cops++;
            if (cops < Math.min(4, p.wanted + 1)) {
              const side = v.spec.width / 2 + 0.8;
              room.peds.spawnCop(v.st.x + Math.cos(v.st.yaw) * side * (cops % 2 ? -1 : 1), v.st.z - Math.sin(v.st.yaw) * side * (cops % 2 ? -1 : 1), p.id);
            }
          }
        } else if (d < 70 && v.ai.mode === 1) {
          // a patrol notices the suspect and joins
          v.ai.mode = 2;
          v.ai.target = p.id;
          v.ai.repathT = 0;
          seen = true;
        }
      }
      for (const n of room.npcs.values()) if (n.kind === 1 && n.target === p.id && n.state !== NPC.DEAD && dist2(n.x, n.z, c.x, c.z) < 70) seen = true;
      if (seen) p.unseen = 0;
      else p.unseen += 0.5;
      // reinforcements
      if (units < UNITS[p.wanted] && room.rng.chance(0.5)) room.traffic.spawnPursuit(p.id, c.x, c.z);
      // evasion
      const need = 12 + p.wanted * 5;
      if (p.unseen > need) {
        p.heat = Math.max(0, p.heat - 0.6);
        const w = this.starsFor(p.heat);
        if (w < p.wanted) {
          p.wanted = w;
          if (w === 0) {
            room.toast(p, 'Fahndung aufgehoben', 'good');
            room.addXp(p, 40);
            p.heat = 0;
          }
        }
      }
      // arrest: officer next to a suspect who has stopped
      const tv = p.veh ? room.vehicles.get(p.veh) : undefined;
      const speed = tv ? Math.hypot(tv.st.vx, tv.st.vz) : Math.hypot(c.vx, c.vz);
      let copNear = false;
      for (const n of room.npcs.values()) if (n.kind === 1 && n.target === p.id && n.state !== NPC.DEAD && n.state !== NPC.KNOCKED && dist2(n.x, n.z, c.x, c.z) < 2.6) copNear = true;
      if (copNear && speed < 1.6 && p.wanted <= 3 && c.mode !== CharMode.Dead) {
        const t = (this.arrestT.get(p.id) ?? 0) + 0.5;
        this.arrestT.set(p.id, t);
        if (t >= 1.5) this.bust(p);
      } else this.arrestT.delete(p.id);
    }
  }

  private bust(p: RoomPlayer): void {
    const room = this.room;
    this.arrestT.delete(p.id);
    room.killPlayer(p, 'Polizei', true);
    room.broadcast({ t: 'chat', from: 0, name: '', text: `${p.name} wurde verhaftet.`, sys: true });
    // officers and units stand down
    for (const n of room.npcs.values()) if (n.kind === 1 && n.target === p.id) { n.target = 0; n.stateT = 6; }
  }

  private officer(n: RoomNpc): void {
    const room = this.room, world = room.world;
    const p = room.players.get(n.target);
    if (!p || p.wanted === 0 || p.char.mode === CharMode.Dead) {
      n.state = NPC.IDLE;
      n.speed = 0;
      if (n.stateT < -8) room.npcs.delete(n.id);
      return;
    }
    n.stateT = 0;
    const c = p.char;
    const dx = c.x - n.x, dz = c.z - n.z;
    const d = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    n.yaw += clamp(angleDiff(n.yaw, want), -8 * DT, 8 * DT);
    const lethal = p.wanted >= 3;
    const stopAt = lethal ? 14 : 1.4;
    if (d > stopAt) {
      n.state = NPC.RUN;
      n.speed = 5.6;
      n.x += (dx / d) * n.speed * DT;
      n.z += (dz / d) * n.speed * DT;
      world.colliders.query(n.x, n.z, 1, this.tmp);
      for (const col of this.tmp) {
        if (col.y1 < n.y + 0.4 || col.y0 > n.y + 1.7) continue;
        if (circleVsCollider(n.x, n.z, 0.32, col, this.hit)) { n.x += this.hit[0]; n.z += this.hit[1]; }
      }
      n.y = world.groundAt(n.x, n.z, n.y + 1.5);
    } else {
      n.speed = 0;
      n.state = lethal ? NPC.AIM : NPC.IDLE;
    }
    if (lethal && d < 34) {
      if (d <= stopAt + 2) n.state = NPC.AIM;
      n.fireT -= DT;
      if (n.fireT <= 0) {
        n.fireT = room.rng.range(0.7, 1.3);
        const hitChance = clamp(0.62 - d * 0.014 - Math.hypot(c.vx, c.vz) * 0.03, 0.08, 0.6) * (p.veh ? 0.5 : 1);
        const hit = room.rng.chance(hitChance);
        const tv = p.veh ? room.vehicles.get(p.veh) : undefined;
        room.broadcastNear({ t: 'shot', by: 0, x: n.x, y: n.y + 1.45, z: n.z, hx: c.x + (hit ? 0 : room.rng.range(-1.5, 1.5)), hy: c.y + 1.1, hz: c.z + (hit ? 0 : room.rng.range(-1.5, 1.5)), hit: hit ? 4 : 1 }, n.x, n.z, 260);
        if (hit) {
          if (tv) { tv.st.hp -= 30; if (tv.st.hp <= 0 && !(tv.st.flags & VF.WRECKED)) { tv.st.hp = 0; tv.st.flags |= VF.WRECKED; room.onWreck(tv, null); } }
          else room.hurtPlayer(p, 8 + p.wanted * 1.5, 'Polizei');
        }
      }
    }
  }
}
