// Activities: co-op story mission, checkpoint races, repeatable deliveries, hidden collectibles, vehicle trade.
import { dist2 } from '../math';
import { findRoute, makeNearest } from '../world/roads';
import { PASS_SADDLE, UETLIBERG_TOP, VILLAGE_CENTER } from '../world/layout';
import type { World } from '../world/world';
import { MissionView } from '../net/protocol';
import { CharMode, DT, VEHICLES, VF } from './types';
import type { GameRoom, RoomPlayer, RoomVehicle } from './room';

export interface Activity {
  id: string;
  kind: 'story' | 'race' | 'delivery' | 'dealer' | 'garage';
  title: string;
  desc: string;
  x: number;
  z: number;
}
export const ACTIVITIES: Activity[] = [
  { id: 'kurier', kind: 'story', title: 'Der Kurier', desc: 'Koop-Mission: Bringe eine Ladung Luxusuhren unbeschädigt ins Bergdorf Alpwil.', x: -196, z: -300 },
  { id: 'seesprint', kind: 'race', title: 'Seequai-Sprint', desc: 'Checkpoint-Rennen vom Bürkliplatz der Goldküste entlang.', x: -228, z: 366 },
  { id: 'passrennen', kind: 'race', title: 'Passrennen', desc: 'Von Alpwil über die Haarnadelkurven der Passstrasse zum Zürichberg.', x: VILLAGE_CENTER.x - 12, z: VILLAGE_CENTER.z - 8 },
  { id: 'lieferdienst', kind: 'delivery', title: 'Lieferdienst', desc: 'Wiederholbare Lieferaufträge quer durch die Stadt.', x: -150, z: 318 },
  { id: 'dealer', kind: 'dealer', title: 'Garage Hürlimann', desc: 'Fahrzeuge kaufen.', x: -770, z: -492 },
  { id: 'garage', kind: 'garage', title: 'Werkstatt', desc: 'Fahrzeug reparieren.', x: -980, z: -498 },
];
export function activity(id: string): Activity {
  return ACTIVITIES.find((a) => a.id === id)!;
}

/** Hidden collectibles ("Goldvreneli"). */
export const SECRETS: { x: number; z: number; hint: string }[] = [
  { x: -118, z: 70, hint: 'Lindenhof' },
  { x: UETLIBERG_TOP.x + 4, z: UETLIBERG_TOP.z - 4, hint: 'Uetliberg Kulm' },
  { x: PASS_SADDLE.x - 4, z: PASS_SADDLE.z - 14, hint: 'Passhöhe' },
  { x: VILLAGE_CENTER.x + 42, z: VILLAGE_CENTER.z + 30, hint: 'Dorfkirche Alpwil' },
  { x: 1392, z: -1087, hint: 'Talschluss' },
  { x: -272, z: 392, hint: 'Seepromenade' },
  { x: 318, z: 392, hint: 'Hinter dem Opernhaus' },
  { x: 372, z: -8, hint: 'Hochschulterrasse' },
  { x: -548, z: -470, hint: 'Am Fuss des Prime-Turms' },
  { x: -1290, z: -838, hint: 'Limmatufer Industrie' },
  { x: 70, z: 214, hint: 'Grossmünster' },
  { x: -92, z: 148, hint: 'St. Peter' },
  { x: -815, z: 84, hint: 'Bäckeranlage' },
  { x: 100, z: -1276, hint: 'Feldweg Nord' },
  { x: 1008, z: 1146, hint: 'Goldküste' },
  { x: -1054, z: 1500, hint: 'Seestrasse West, Kartenrand' },
  { x: 742, z: -500, hint: 'Passstrasse Süd' },
  { x: -640, z: -760, hint: 'Kornhausbrücke' },
  { x: 880, z: -404, hint: 'Zürichberg-Wald' },
  { x: -1180, z: -1214, hint: 'Hofstrasse' },
];

export interface MissionState {
  id: string;
  kind: 'story' | 'race' | 'delivery';
  step: number;
  timer: number;
  /** story */
  vanId: number;
  cargo: number;
  awayT: number;
  loadT: number;
  /** race / delivery */
  cps: { x: number; z: number }[];
  cp: number;
  elapsed: number;
  countdown: number;
  tx: number;
  tz: number;
  dist: number;
  /** players sharing this mission (co-op) */
  party: number[];
  owner: number;
}

const RACES: Record<string, { way: [number, number][]; gold: number; silver: number; bronze: number; purse: number }> = {
  seesprint: { way: [[-228, 366], [40, 370], [258, 392], [590, 464], [830, 662], [960, 960]], gold: 62, silver: 76, bronze: 95, purse: 1400 },
  passrennen: { way: [[VILLAGE_CENTER.x, VILLAGE_CENTER.z - 10], [PASS_SADDLE.x, PASS_SADDLE.z], [742, -500], [880, -400]], gold: 150, silver: 185, bronze: 230, purse: 2600 },
};

export class Missions {
  private nr = makeNearest();
  private secretT = 0;
  constructor(private room: GameRoom) {}

  private get world(): World {
    return this.room.world;
  }
  private nodeNear(x: number, z: number): number {
    const n = this.world.roadIndex.nearest(x, z, 200, this.nr, (e) => e.type !== 'track');
    if (!n) return 0;
    return n.t < 0.5 ? n.edge.a : n.edge.b;
  }
  /** Checkpoints every ~170 m along the fastest route through the way points. */
  private routePoints(way: [number, number][]): { x: number; z: number }[] {
    const g = this.world.roads;
    const out: { x: number; z: number }[] = [];
    let acc = 0;
    for (let i = 0; i < way.length - 1; i++) {
      const path = findRoute(g, this.nodeNear(way[i][0], way[i][1]), this.nodeNear(way[i + 1][0], way[i + 1][1]));
      for (let k = 0; k < path.length - 1; k++) {
        const a = g.nodes[path[k]], b = g.nodes[path[k + 1]];
        const e = g.edges[a.edges.find((ei) => { const ed = g.edges[ei]; return (ed.a === a.id && ed.b === b.id) || (ed.b === a.id && ed.a === b.id); })!];
        const fwd = e.a === a.id;
        for (let j = 1; j < e.n; j++) {
          const idx = fwd ? j : e.n - 1 - j;
          const prev = fwd ? j - 1 : e.n - j;
          acc += Math.hypot(e.px[idx] - e.px[prev], e.pz[idx] - e.pz[prev]);
          if (acc >= 170) { acc = 0; out.push({ x: e.px[idx], z: e.pz[idx] }); }
        }
      }
    }
    const last = way[way.length - 1];
    const ln = g.nodes[this.nodeNear(last[0], last[1])];
    if (!out.length || dist2(out[out.length - 1].x, out[out.length - 1].z, ln.x, ln.z) > 60) out.push({ x: ln.x, z: ln.z });
    else out[out.length - 1] = { x: ln.x, z: ln.z };
    return out;
  }

  // ------------------------------------------------------------ views
  view(p: RoomPlayer): MissionView | null {
    const m = p.mission;
    if (!m) return null;
    const a = activity(m.id === 'job' ? 'lieferdienst' : m.id);
    if (m.kind === 'story') {
      const van = this.room.vehicles.get(m.vanId);
      const texts = ['', 'Steig in den Lieferwagen beim Hauptbahnhof.', 'Hole die Uhren im Atelier am Rennweg ab.', 'Liefere die Uhren nach Alpwil. Fahr vorsichtig!', ''];
      let x = m.tx, z = m.tz;
      if (m.step === 1 && van) { x = van.st.x; z = van.st.z; }
      return { id: m.id, kind: 'story', title: a.title, text: m.loadT > 0 ? 'Ware wird verladen …' : texts[m.step], x, z, r: m.step === 1 ? 3 : 7, timer: m.step === 3 ? m.timer : -1, step: m.step, steps: 3, info: m.step === 3 ? `Ware ${Math.round(m.cargo)} %` : undefined };
    }
    if (m.kind === 'race') {
      const cp = m.cps[m.cp] ?? m.cps[m.cps.length - 1];
      return { id: m.id, kind: 'race', title: a.title, text: m.countdown > 0 ? `Start in ${Math.ceil(m.countdown)}` : `Checkpoint ${m.cp + 1}/${m.cps.length}`, x: cp.x, z: cp.z, r: 9, timer: m.elapsed, step: m.cp, steps: m.cps.length, info: m.countdown > 0 ? 'countdown' : 'stopwatch' };
    }
    return { id: m.id, kind: 'delivery', title: 'Lieferdienst', text: m.step === 0 ? 'Hole das Paket ab.' : 'Liefere das Paket aus.', x: m.tx, z: m.tz, r: 7, timer: m.timer, step: m.step, steps: 2 };
  }
  sync(p: RoomPlayer): void {
    p.send({ t: 'mission', m: this.view(p) });
  }
  private syncParty(m: MissionState): void {
    for (const id of m.party) {
      const p = this.room.players.get(id);
      if (p) this.sync(p);
    }
  }
  private end(m: MissionState, ok: boolean, title: string, reward: number, xp: number, detail?: string): void {
    for (const id of m.party) {
      const p = this.room.players.get(id);
      if (!p || p.mission !== m) continue;
      p.mission = null;
      if (ok) {
        if (reward) this.room.addMoney(p, reward);
        if (xp) this.room.addXp(p, xp);
        if (m.kind === 'story' && !p.profile.missions.includes(m.id)) p.profile.missions.push(m.id);
      }
      p.send({ t: 'mission', m: null, result: { ok, title, reward: ok ? reward : 0, xp: ok ? xp : 0, detail } });
      this.room.syncProfile(p);
    }
    const van = this.room.vehicles.get(m.vanId);
    if (van) van.cargo = undefined;
  }

  // ------------------------------------------------------------ commands
  command(p: RoomPlayer, op: 'start' | 'abort', id?: string): void {
    if (op === 'abort') {
      if (p.mission) {
        const m = p.mission;
        if (m.owner === p.id || m.kind !== 'story') this.end(m, false, 'Abgebrochen', 0, 0);
        else { p.mission = null; m.party = m.party.filter((x) => x !== p.id); this.sync(p); }
      }
      return;
    }
    if (p.mission || !id || p.char.mode === CharMode.Dead) return;
    const a = ACTIVITIES.find((x) => x.id === id);
    if (!a || dist2(p.char.x, p.char.z, a.x, a.z) > 14) return;
    if (a.kind === 'story') this.startStory(p);
    else if (a.kind === 'race') this.startRace(p, a.id);
    else if (a.kind === 'delivery') this.startDelivery(p);
  }
  /** Context interaction ("use" key) near an activity marker. */
  interact(p: RoomPlayer): boolean {
    if (p.mission || p.veh) return false;
    for (const a of ACTIVITIES) {
      if (a.kind === 'dealer' || a.kind === 'garage') continue;
      if (dist2(p.char.x, p.char.z, a.x, a.z) < 3.2) {
        this.command(p, 'start', a.id);
        return true;
      }
    }
    return false;
  }

  private blank(id: string, kind: MissionState['kind'], owner: number): MissionState {
    return { id, kind, step: 0, timer: -1, vanId: 0, cargo: 100, awayT: 0, loadT: 0, cps: [], cp: 0, elapsed: 0, countdown: 0, tx: 0, tz: 0, dist: 0, party: [owner], owner };
  }
  private startStory(p: RoomPlayer): void {
    const room = this.room;
    const m = this.blank('kurier', 'story', p.id);
    // co-op: everyone in the lobby without an active job joins
    for (const o of room.players.values()) if (o !== p && o.connected && !o.mission) m.party.push(o.id);
    const van = room.spawnVehicle(4, -128, -332, Math.PI, 3);
    van.owner = p.id;
    van.cargo = 'kurier';
    m.vanId = van.id;
    m.step = 1;
    for (const id of m.party) room.players.get(id)!.mission = m;
    this.syncParty(m);
    room.broadcast({ t: 'chat', from: 0, name: '', text: `${p.name} hat die Mission «Der Kurier» gestartet.`, sys: true });
  }
  private startRace(p: RoomPlayer, id: string): void {
    const def = RACES[id];
    if (!def) return;
    const m = this.blank(id, 'race', p.id);
    m.cps = this.routePoints(def.way);
    m.countdown = 3.99;
    p.mission = m;
    this.sync(p);
  }
  private startDelivery(p: RoomPlayer): void {
    const room = this.room, g = this.world.roads;
    const m = this.blank('job', 'delivery', p.id);
    const pick = (fromX: number, fromZ: number, min: number, max: number) => {
      for (let i = 0; i < 60; i++) {
        const n = g.nodes[room.rng.int(0, g.nodes.length - 1)];
        const d = dist2(n.x, n.z, fromX, fromZ);
        if (d > min && d < max && n.edges.length >= 2 && !g.edges[n.edges[0]].flag[0]) return n;
      }
      return g.nodes[0];
    };
    const a = pick(p.char.x, p.char.z, 250, 700);
    const b = pick(a.x, a.z, 450, 1500);
    m.tx = a.x; m.tz = a.z;
    m.cps = [{ x: a.x, z: a.z }, { x: b.x, z: b.z }];
    m.dist = dist2(p.char.x, p.char.z, a.x, a.z) + dist2(a.x, a.z, b.x, b.z);
    m.timer = 40 + m.dist / 7;
    p.mission = m;
    this.sync(p);
  }

  // ------------------------------------------------------------ hooks
  onEnterVehicle(p: RoomPlayer, v: RoomVehicle): void {
    const m = p.mission;
    if (m && m.kind === 'story' && m.step === 1 && v.id === m.vanId) {
      m.step = 2;
      m.tx = -152; m.tz = -62;
      this.syncParty(m);
    }
  }
  onCrash(p: RoomPlayer, impact: number): void {
    const m = p.mission;
    if (m && m.kind === 'story' && m.step === 3 && p.veh === m.vanId && impact > 3.5) {
      m.cargo = Math.max(0, m.cargo - (impact - 3.5) * 2.4);
      this.syncParty(m);
    }
  }
  onPlayerDown(p: RoomPlayer): void {
    const m = p.mission;
    if (!m) return;
    if (m.kind !== 'story') this.end(m, false, 'Gescheitert', 0, 0, 'Du bist ausgefallen.');
    else if (m.party.every((id) => { const o = this.room.players.get(id); return !o || o.char.mode === CharMode.Dead; })) this.end(m, false, 'Mission gescheitert', 0, 0, 'Das Team ist ausgefallen.');
  }

  update(): void {
    const room = this.room;
    const seen = new Set<MissionState>();
    for (const p of room.players.values()) {
      const m = p.mission;
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (m.kind === 'story') this.updateStory(m);
      else if (m.kind === 'race') this.updateRace(p, m);
      else this.updateDelivery(p, m);
    }
    // collectibles
    this.secretT -= DT;
    if (this.secretT <= 0) {
      this.secretT = 0.25;
      for (const p of room.players.values()) {
        if (!p.connected || p.char.mode === CharMode.Dead) continue;
        for (let i = 0; i < SECRETS.length; i++) {
          if (p.profile.secrets.includes(i)) continue;
          const s = SECRETS[i];
          if (Math.abs(p.char.x - s.x) < 3.2 && Math.abs(p.char.z - s.z) < 3.2) {
            p.profile.secrets.push(i);
            room.addMoney(p, 400, `Goldvreneli ${p.profile.secrets.length}/${SECRETS.length} · ${s.hint}`);
            room.addXp(p, 150);
            room.syncProfile(p);
            p.send({ t: 'fx', kind: 'cash', x: s.x, y: p.char.y + 1, z: s.z });
            if (p.profile.secrets.length === SECRETS.length) { room.addMoney(p, 10000, 'Alle Goldvreneli gefunden'); room.addXp(p, 2000); }
          }
        }
      }
    }
  }

  private updateStory(m: MissionState): void {
    const room = this.room;
    const van = room.vehicles.get(m.vanId);
    if (!van || van.st.flags & VF.WRECKED) { this.end(m, false, 'Mission gescheitert', 0, 0, 'Der Lieferwagen wurde zerstört.'); return; }
    const driver = room.players.get(van.driver);
    const speed = Math.hypot(van.st.vx, van.st.vz);
    if (m.step >= 2) {
      // abandoned van
      if (!driver) { m.awayT += DT; if (m.awayT > 45) { this.end(m, false, 'Mission gescheitert', 0, 0, 'Der Lieferwagen wurde zurückgelassen.'); return; } }
      else m.awayT = 0;
    }
    if (m.step === 2) {
      if (driver && dist2(van.st.x, van.st.z, m.tx, m.tz) < 9 && speed < 1.5) {
        if (m.loadT <= 0) { m.loadT = 2.2; this.syncParty(m); }
        else {
          m.loadT -= DT;
          if (m.loadT <= 0) {
            m.step = 3;
            m.tx = VILLAGE_CENTER.x - 22; m.tz = VILLAGE_CENTER.z - 10;
            m.timer = 300;
            m.cargo = 100;
            this.syncParty(m);
          }
        }
      } else if (m.loadT > 0) { m.loadT = 0; this.syncParty(m); }
    } else if (m.step === 3) {
      m.timer -= DT;
      if (m.cargo <= 0) { this.end(m, false, 'Mission gescheitert', 0, 0, 'Die Uhren sind zu Bruch gegangen.'); return; }
      if (m.timer <= 0) { this.end(m, false, 'Mission gescheitert', 0, 0, 'Zu spät – der Kunde ist weg.'); return; }
      if (driver && dist2(van.st.x, van.st.z, m.tx, m.tz) < 9 && speed < 1.5) {
        const reward = Math.round((2400 * (0.45 + 0.55 * (m.cargo / 100)) + Math.max(0, m.timer) * 6) / 10) * 10;
        this.end(m, true, 'Mission erfüllt', reward, 650, `Ware ${Math.round(m.cargo)} % intakt · ${Math.round(m.timer)} s Reserve`);
        van.owner = 0;
        return;
      }
      if (room.tick % 30 === 0) this.syncParty(m);
    }
  }

  private updateRace(p: RoomPlayer, m: MissionState): void {
    const room = this.room;
    if (m.countdown > 0) {
      const before = Math.ceil(m.countdown);
      m.countdown -= DT;
      if (Math.ceil(m.countdown) !== before || m.countdown <= 0) this.sync(p);
      if (m.countdown > 0) return;
    }
    m.elapsed += DT;
    const cp = m.cps[m.cp];
    if (dist2(p.char.x, p.char.z, cp.x, cp.z) < 13) {
      m.cp++;
      if (m.cp >= m.cps.length) {
        const def = RACES[m.id];
        const t = m.elapsed;
        const medal = t <= def.gold ? 'Gold' : t <= def.silver ? 'Silber' : t <= def.bronze ? 'Bronze' : '';
        const reward = medal === 'Gold' ? def.purse : medal === 'Silber' ? Math.round(def.purse * 0.6) : medal === 'Bronze' ? Math.round(def.purse * 0.3) : 100;
        const best = p.profile.best[m.id];
        if (!best || t < best) p.profile.best[m.id] = Math.round(t * 100) / 100;
        p.profile.stats.races++;
        this.end(m, true, medal ? `${medal}-Medaille` : 'Im Ziel', reward, medal ? 300 : 80, `Zeit ${t.toFixed(2)} s${best && t < best ? ' · neue Bestzeit' : ''}`);
        return;
      }
      this.sync(p);
    }
    if (m.elapsed > 600 || !p.veh && m.elapsed > 20 && dist2(p.char.x, p.char.z, cp.x, cp.z) > 900) this.end(m, false, 'Rennen abgebrochen', 0, 0);
  }

  private updateDelivery(p: RoomPlayer, m: MissionState): void {
    m.timer -= DT;
    if (m.timer <= 0) { this.end(m, false, 'Lieferung gescheitert', 0, 0, 'Zeit abgelaufen.'); return; }
    const v = p.veh ? this.room.vehicles.get(p.veh) : undefined;
    const speed = v ? Math.hypot(v.st.vx, v.st.vz) : Math.hypot(p.char.vx, p.char.vz);
    if (dist2(p.char.x, p.char.z, m.tx, m.tz) < 8 && speed < 2.5) {
      if (m.step === 0) {
        m.step = 1;
        m.tx = m.cps[1].x; m.tz = m.cps[1].z;
        this.sync(p);
      } else {
        const reward = Math.round((180 + m.dist * 0.42 + m.timer * 2) / 10) * 10;
        p.profile.stats.deliveries++;
        this.end(m, true, 'Lieferung zugestellt', reward, 120, `${(m.dist / 1000).toFixed(1)} km`);
      }
    }
  }

  // ------------------------------------------------------------ trade
  buy(p: RoomPlayer, item: string, id: number): void {
    const room = this.room;
    if (item === 'vehicle') {
      const a = activity('dealer');
      const spec = VEHICLES[id];
      if (!spec || spec.price <= 0 || dist2(p.char.x, p.char.z, a.x, a.z) > 40) return;
      if (p.profile.garage.includes(id)) { room.toast(p, 'Dieses Fahrzeug besitzt du bereits.', 'info'); return; }
      const lvl = Math.max(1, Math.floor(1 + 0)); void lvl;
      if (p.profile.money < spec.price) { room.toast(p, 'Zu wenig Geld.', 'bad'); return; }
      room.addMoney(p, -spec.price, spec.name);
      p.profile.garage.push(id);
      room.syncProfile(p);
      room.save(p);
      this.spawnOwned(p, id, true);
    } else if (item === 'repair') {
      const v = p.veh ? room.vehicles.get(p.veh) : undefined;
      const a = activity('garage');
      if (!v || dist2(p.char.x, p.char.z, a.x, a.z) > 30) { room.toast(p, 'Fahre mit dem Fahrzeug zur Werkstatt.', 'info'); return; }
      const cost = Math.round(((1 - v.st.hp / v.spec.hp) * 900 + 60) / 10) * 10;
      if (p.profile.money < cost) { room.toast(p, 'Zu wenig Geld.', 'bad'); return; }
      room.addMoney(p, -cost, 'Reparatur');
      v.st.hp = v.spec.hp;
      v.st.flags &= ~VF.WRECKED;
      v.fireT = 0;
    } else if (item === 'ammo') {
      if (p.profile.money < 120) { room.toast(p, 'Zu wenig Geld.', 'bad'); return; }
      room.addMoney(p, -120, 'Munition');
      p.ammo = Math.min(240, p.ammo + 48);
    }
  }
  /** Deliver an owned vehicle to the player (small fee unless freshly bought). */
  spawnOwned(p: RoomPlayer, spec: number, free = false): void {
    const room = this.room;
    if (!p.profile.garage.includes(spec)) return;
    if (p.veh) { room.toast(p, 'Steig zuerst aus.', 'info'); return; }
    if (!free) {
      if (p.profile.money < 100) { room.toast(p, 'Zustellung kostet CHF 100.', 'bad'); return; }
      room.addMoney(p, -100, 'Fahrzeugzustellung');
    }
    // remove a previous instance of this owned car
    for (const v of room.vehicles.values()) if (v.owner === p.id && v.spec.id === spec && !v.cargo && !v.driver) room.removeVehicle(v);
    const n = this.world.roadIndex.nearest(p.char.x, p.char.z, 120, this.nr, (e) => e.type !== 'track' && e.type !== 'highway');
    let x = p.char.x + 4, z = p.char.z, yaw = p.char.yaw;
    if (n) {
      const e = n.edge, i = n.seg;
      const tx = e.px[i + 1] - e.px[i], tz = e.pz[i + 1] - e.pz[i];
      const l = Math.hypot(tx, tz) || 1;
      const off = e.width / 2 - 1.2;
      x = e.px[i] + (tx / l) * 1 - (tz / l) * off;
      z = e.pz[i] + (tz / l) * 1 + (tx / l) * off;
      yaw = Math.atan2(tx, tz);
    }
    const v = room.spawnVehicle(spec, x, z, yaw, (p.id * 5 + spec * 3) % 16);
    v.owner = p.id;
    room.toast(p, `${v.spec.name} steht bereit.`, 'good');
  }
}
