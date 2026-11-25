// Map rendering for the minimap and the full-screen world map: pre-rendered base layer + dynamic overlays and GPS routes.
import type { World } from '../../shared/world/world';
import { N, ZN } from '../../shared/world/world';
import { WORLD_HALF, Zone } from '../../shared/world/layout';
import { findRoute, makeNearest } from '../../shared/world/roads';
import { BKind } from '../../shared/world/city';
import { ACTIVITIES, SECRETS } from '../../shared/sim/missions';

export const MAP_PX = 1536; // 2 m per pixel
const S = MAP_PX / (WORLD_HALF * 2);

export interface MapOverlay {
  x: number;
  z: number;
  yaw: number;
  players: { name: string; x: number; z: number }[];
  blips: { x: number; z: number; kind: number }[];
  target: { x: number; z: number } | null;
  waypoint: { x: number; z: number } | null;
  route: Float32Array | null;
  secrets: number[];
  time: number;
}
const KIND_COL: Record<string, string> = { story: '#ffd23a', race: '#45b6ff', delivery: '#5fd38d', dealer: '#f3f1ea', garage: '#f3f1ea' };

export class MapView {
  readonly base: HTMLCanvasElement;
  private nr = makeNearest();

  constructor(private world: World) {
    const c = document.createElement('canvas');
    c.width = c.height = MAP_PX;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(MAP_PX, MAP_PX);
    const d = img.data;
    const ZC: Record<number, [number, number, number]> = {
      [Zone.Water]: [22, 50, 74], [Zone.OldTown]: [46, 44, 42], [Zone.Downtown]: [44, 45, 47], [Zone.Business]: [41, 45, 50], [Zone.Residential]: [38, 46, 39],
      [Zone.Hillside]: [36, 46, 37], [Zone.Industrial]: [44, 43, 42], [Zone.Village]: [44, 48, 38], [Zone.Rural]: [43, 50, 36], [Zone.Forest]: [28, 44, 32],
      [Zone.Alpine]: [58, 60, 60], [Zone.Park]: [36, 58, 40], [Zone.Station]: [52, 48, 46],
    };
    const H = world.height;
    for (let py = 0; py < MAP_PX; py++) {
      const iz = Math.min(N - 1, Math.round(py / S / 2)), zi = Math.min(ZN - 1, Math.floor(py / S / 8));
      for (let px = 0; px < MAP_PX; px++) {
        const ix = Math.min(N - 1, Math.round(px / S / 2));
        const h = H[iz * N + ix];
        let c3 = ZC[world.zone[zi * ZN + Math.min(ZN - 1, Math.floor(px / S / 8))]] ?? [40, 40, 40];
        let r = c3[0], g = c3[1], b = c3[2];
        if (h < -0.15) { const k = Math.max(0.55, 1 + h * 0.02); r = 22 * k; g = 50 * k; b = 76 * k; }
        else {
          // relief shading
          const hx = H[iz * N + Math.min(N - 1, ix + 2)] - H[iz * N + Math.max(0, ix - 2)], hz = H[Math.min(N - 1, iz + 2) * N + ix] - H[Math.max(0, iz - 2) * N + ix];
          const sh = Math.max(0.55, Math.min(1.7, 1 - (hx + hz) * 0.045));
          if (h > 400) { r = 120; g = 124; b = 130; }
          r *= sh; g *= sh; b *= sh;
        }
        const k = (py * MAP_PX + px) * 4;
        d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const X = (x: number) => (x + WORLD_HALF) * S, Z = (z: number) => (z + WORLD_HALF) * S;
    // buildings
    for (const b of world.city.buildings) {
      const s = Math.sin(b.rot), co = Math.cos(b.rot);
      const hw = b.w / 2, hd = b.d / 2;
      ctx.fillStyle = b.kind >= BKind.Station ? '#8a8f96' : b.kind === BKind.Tower ? '#6d7680' : '#5b5f66';
      ctx.beginPath();
      for (const [lx, lz] of [[-hw, hd], [hw, hd], [hw, -hd], [-hw, -hd]]) ctx.lineTo(X(b.x + co * lx + s * lz), Z(b.z - s * lx + co * lz));
      ctx.closePath();
      ctx.fill();
    }
    // railway
    ctx.strokeStyle = '#7b7469';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    for (const t of world.roads.tracks) {
      ctx.beginPath();
      t.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // roads: casing then fill, minor first
    const order = ['alley', 'street', 'rural', 'main', 'highway'];
    const col: Record<string, string> = { alley: '#75787d', street: '#a2a5a9', rural: '#b3ae9f', main: '#dedad0', highway: '#e2b04a' };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const type of order) {
      ctx.strokeStyle = col[type];
      for (const e of world.roads.edges) {
        if (e.type !== type) continue;
        ctx.lineWidth = Math.max(1.4, e.width * S * (type === 'highway' ? 0.8 : 1));
        ctx.beginPath();
        for (let i = 0; i < e.n; i++) (i ? ctx.lineTo(X(e.px[i]), Z(e.pz[i])) : ctx.moveTo(X(e.px[i]), Z(e.pz[i])));
        ctx.stroke();
      }
    }
    this.base = c;
  }

  /** GPS: road route from a position to a target as world-space polyline [x,z,...]. */
  route(fx: number, fz: number, tx: number, tz: number): Float32Array | null {
    const w = this.world, g = w.roads;
    const a = w.roadIndex.nearest(fx, fz, 250, this.nr, (e) => e.type !== 'track');
    if (!a) return null;
    const ae = a.edge, as = a.s;
    const b = w.roadIndex.nearest(tx, tz, 250, this.nr, (e) => e.type !== 'track');
    if (!b) return null;
    const be = b.edge, bs = b.s;
    const out: number[] = [fx, fz];
    if (ae === be) {
      const step = as < bs ? 1 : -1;
      for (let i = 0; i < ae.n; i++) { const k = step > 0 ? i : ae.n - 1 - i; if ((ae.cum[k] - as) * step > 0 && (bs - ae.cum[k]) * step > 0) out.push(ae.px[k], ae.pz[k]); }
      out.push(tx, tz);
      return new Float32Array(out);
    }
    // choose the end nodes that give the shortest total
    let best: number[] = [], bestLen = 1e12, bestA = 0, bestB = 0;
    for (const na of [ae.a, ae.b]) for (const nb of [be.a, be.b]) {
      const path = findRoute(g, na, nb);
      if (!path.length) continue;
      let len = (na === ae.a ? as : ae.length - as) + (nb === be.a ? bs : be.length - bs);
      for (let i = 0; i < path.length - 1; i++) {
        const n0 = g.nodes[path[i]], n1 = path[i + 1];
        let m = 1e9;
        for (const ei of n0.edges) { const e = g.edges[ei]; if ((e.a === n1 || e.b === n1) && e.length < m) m = e.length; }
        len += m;
      }
      if (len < bestLen) { bestLen = len; best = path; bestA = na; bestB = nb; }
    }
    if (!best.length) return null;
    const pushEdge = (e: typeof ae, from: number, to: number) => {
      // samples with cum strictly between from and to, in travel order
      const dir = to > from ? 1 : -1;
      for (let i = 0; i < e.n; i++) { const k = dir > 0 ? i : e.n - 1 - i; if ((e.cum[k] - from) * dir >= 0 && (to - e.cum[k]) * dir >= 0) out.push(e.px[k], e.pz[k]); }
    };
    pushEdge(ae, as, bestA === ae.a ? 0 : ae.length);
    for (let i = 0; i < best.length - 1; i++) {
      const n0 = g.nodes[best[i]], n1 = best[i + 1];
      let pick = null as typeof ae | null;
      for (const ei of n0.edges) { const e = g.edges[ei]; if ((e.a === n1 || e.b === n1) && (!pick || e.length < pick.length)) pick = e; }
      if (!pick) continue;
      if (pick.a === n0.id) pushEdge(pick, 0, pick.length);
      else pushEdge(pick, pick.length, 0);
    }
    pushEdge(be, bestB === be.a ? 0 : be.length, bs);
    out.push(tx, tz);
    return new Float32Array(out);
  }

  /** Rotating minimap: heading up. */
  drawMini(ctx: CanvasRenderingContext2D, size: number, o: MapOverlay, camYaw: number, radius: number): void {
    const k = size / (radius * 2); // px per metre
    ctx.save();
    ctx.fillStyle = '#14171b';
    ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2, size * 0.58);
    ctx.rotate(Math.PI + camYaw);
    ctx.scale(k / S, k / S);
    ctx.translate(-(o.x + WORLD_HALF) * S, -(o.z + WORLD_HALF) * S);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0);
    this.overlays(ctx, o, 1 / (k / S), false);
    ctx.restore();
    // out-of-range target indicator on the rim
    const tgt = o.target ?? o.waypoint;
    if (tgt) {
      const dx = tgt.x - o.x, dz = tgt.z - o.z;
      const a = Math.PI + camYaw;
      const rx = (dx * Math.cos(a) - dz * Math.sin(a)) * k, ry = (dx * Math.sin(a) + dz * Math.cos(a)) * k;
      const cx = size / 2, cy = size * 0.58;
      if (Math.abs(rx) > size / 2 - 8 || ry > size - cy - 8 || ry < -cy + 8) {
        const sc = Math.min((size / 2 - 9) / Math.abs(rx || 1e-6), (ry > 0 ? size - cy - 9 : cy - 9) / Math.abs(ry || 1e-6));
        ctx.fillStyle = o.target ? '#ffd23a' : '#ff5fd2';
        ctx.fillRect(cx + rx * sc - 5, cy + ry * sc - 5, 10, 10);
      }
    }
    // player arrow
    ctx.save();
    ctx.translate(size / 2, size * 0.58);
    ctx.rotate(camYaw - o.yaw);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#0b0c0e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(6, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    // north marker
    const na = Math.PI + camYaw;
    const nx = -Math.sin(na) * -1, ny = -Math.cos(na);
    void nx; void ny;
    ctx.save();
    ctx.translate(size - 15, 15);
    ctx.rotate(Math.PI + camYaw);
    ctx.fillStyle = '#e2001a';
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(4, 0); ctx.lineTo(-4, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f3f1ea';
    ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(4, 0); ctx.lineTo(-4, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /** North-up full map. scale = px per metre, (cx,cz) = world position at the screen centre. */
  drawBig(ctx: CanvasRenderingContext2D, w: number, h: number, cx: number, cz: number, scale: number, o: MapOverlay, cursor: { x: number; z: number } | null): void {
    ctx.save();
    ctx.fillStyle = '#0f1114';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale / S, scale / S);
    ctx.translate(-(cx + WORLD_HALF) * S, -(cz + WORLD_HALF) * S);
    ctx.drawImage(this.base, 0, 0);
    this.overlays(ctx, o, S / scale, true);
    // labels
    const u = S / scale;
    ctx.font = `700 ${11 * u}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textBaseline = 'middle';
    for (const p of this.world.pois) {
      if (p.kind === 'spawn') continue;
      const x = (p.x + WORLD_HALF) * S, z = (p.z + WORLD_HALF) * S;
      ctx.fillStyle = '#0b0c0e';
      ctx.fillRect(x - 2.5 * u, z - 2.5 * u, 5 * u, 5 * u);
      ctx.fillStyle = '#f3f1ea';
      ctx.fillRect(x - 1.5 * u, z - 1.5 * u, 3 * u, 3 * u);
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = 'rgba(11,12,14,.85)';
      ctx.strokeText(p.name.toUpperCase(), x + 7 * u, z);
      ctx.fillText(p.name.toUpperCase(), x + 7 * u, z);
    }
    for (const pl of o.players) {
      const x = (pl.x + WORLD_HALF) * S, z = (pl.z + WORLD_HALF) * S;
      ctx.fillStyle = '#45b6ff';
      ctx.strokeStyle = 'rgba(11,12,14,.85)';
      ctx.strokeText(pl.name, x + 8 * u, z);
      ctx.fillText(pl.name, x + 8 * u, z);
    }
    if (cursor) {
      const x = (cursor.x + WORLD_HALF) * S, z = (cursor.z + WORLD_HALF) * S;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * u;
      ctx.beginPath(); ctx.moveTo(x - 10 * u, z); ctx.lineTo(x + 10 * u, z); ctx.moveTo(x, z - 10 * u); ctx.lineTo(x, z + 10 * u); ctx.stroke();
    }
    // own arrow
    ctx.translate((o.x + WORLD_HALF) * S, (o.z + WORLD_HALF) * S);
    ctx.rotate(Math.PI - o.yaw);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#0b0c0e';
    ctx.lineWidth = 1.5 * u;
    ctx.beginPath(); ctx.moveTo(0, -9 * u); ctx.lineTo(7 * u, 8 * u); ctx.lineTo(0, 4 * u); ctx.lineTo(-7 * u, 8 * u); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /** Overlays drawn in base-map pixel space; u = base pixels per screen pixel. */
  private overlays(ctx: CanvasRenderingContext2D, o: MapOverlay, u: number, big: boolean): void {
    const X = (x: number) => (x + WORLD_HALF) * S, Z = (z: number) => (z + WORLD_HALF) * S;
    if (o.route && o.route.length >= 4) {
      ctx.strokeStyle = o.target ? '#ffd23a' : '#ff5fd2';
      ctx.lineWidth = 3.4 * u;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < o.route.length; i += 2) (i ? ctx.lineTo(X(o.route[i]), Z(o.route[i + 1])) : ctx.moveTo(X(o.route[i]), Z(o.route[i + 1])));
      ctx.stroke();
    }
    const sq = (x: number, z: number, r: number, col: string, ring = true) => {
      if (ring) { ctx.fillStyle = '#0b0c0e'; ctx.fillRect(X(x) - (r + 1.5) * u, Z(z) - (r + 1.5) * u, (r + 1.5) * 2 * u, (r + 1.5) * 2 * u); }
      ctx.fillStyle = col;
      ctx.fillRect(X(x) - r * u, Z(z) - r * u, r * 2 * u, r * 2 * u);
    };
    if (!o.target) for (const a of ACTIVITIES) sq(a.x, a.z, 4, KIND_COL[a.kind] ?? '#fff');
    if (big) SECRETS.forEach((s, i) => { if (o.secrets.includes(i)) sq(s.x, s.z, 2, '#8a7a3a', false); });
    for (const b of o.blips) sq(b.x, b.z, 3.5, Math.floor(o.time * 3) % 2 ? '#e2001a' : '#3c7bff');
    for (const p of o.players) sq(p.x, p.z, 4, '#45b6ff');
    if (o.waypoint) sq(o.waypoint.x, o.waypoint.z, 5, '#ff5fd2');
    if (o.target) {
      const x = X(o.target.x), z = Z(o.target.z), r = 6 * u;
      ctx.fillStyle = '#0b0c0e';
      ctx.beginPath(); ctx.moveTo(x, z - r * 1.35); ctx.lineTo(x + r * 1.35, z); ctx.lineTo(x, z + r * 1.35); ctx.lineTo(x - r * 1.35, z); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffd23a';
      ctx.beginPath(); ctx.moveTo(x, z - r); ctx.lineTo(x + r, z); ctx.lineTo(x, z + r); ctx.lineTo(x - r, z); ctx.closePath(); ctx.fill();
    }
  }
}
