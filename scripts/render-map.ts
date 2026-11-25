// Debug: renders a top-down map of the generated world to PNG and prints road statistics.
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { buildWorld, N, RES } from '../src/shared/world/world';
import { Zone } from '../src/shared/world/layout';
import { BKind } from '../src/shared/world/city';

const out = process.argv[2] || 'map.png';
const region = process.argv[3] ? process.argv[3].split(',').map(Number) : [-1536, -1536, 1536, 1536];
const scale = Number(process.argv[4] || 2); // metres per pixel
const w = buildWorld();
console.log('gen ms', w.genMs, 'nodes', w.roads.nodes.length, 'edges', w.roads.edges.length, 'buildings', w.city.buildings.length, 'trees', w.city.trees.length, 'lamps', w.city.lamps.length, 'parking', w.city.parking.length, 'signals', w.city.signals.length, 'colliders', w.colliders.all.length);

const [x0, z0, x1, z1] = region;
const W = Math.round((x1 - x0) / scale), H = Math.round((z1 - z0) / scale);
const png = new PNG({ width: W, height: H });
const ZC: Record<number, [number, number, number]> = {
  [Zone.Water]: [60, 110, 160], [Zone.OldTown]: [205, 180, 150], [Zone.Downtown]: [200, 195, 185], [Zone.Business]: [170, 185, 200],
  [Zone.Residential]: [150, 185, 130], [Zone.Hillside]: [140, 180, 120], [Zone.Industrial]: [170, 165, 160], [Zone.Village]: [190, 200, 130],
  [Zone.Rural]: [170, 195, 110], [Zone.Forest]: [70, 120, 70], [Zone.Alpine]: [150, 150, 145], [Zone.Park]: [110, 190, 110], [Zone.Station]: [130, 120, 115],
};
const set = (px: number, pz: number, r: number, g: number, b: number) => {
  if (px < 0 || pz < 0 || px >= W || pz >= H) return;
  const i = (pz * W + px) * 4;
  png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
};
for (let pz = 0; pz < H; pz++) {
  for (let px = 0; px < W; px++) {
    const x = x0 + (px + 0.5) * scale, z = z0 + (pz + 0.5) * scale;
    const h = w.visAt(x, z);
    const hx = w.visAt(x + 3, z) - w.visAt(x - 3, z), hz = w.visAt(x, z + 3) - w.visAt(x, z - 3);
    const shade = Math.max(0.35, Math.min(1.5, 1 + (-hx - hz) * 0.12));
    let c = ZC[w.zoneAt(x, z)] || [255, 0, 255];
    const s = w.surfaceAt(x, z);
    if (h < 0) c = [50 + Math.max(-40, h * 3), 100 + Math.max(-50, h * 3), 160];
    else if (s === 1) c = [70, 72, 78];
    else if (s === 2) c = [150, 135, 120];
    else if (s === 3) c = [190, 188, 184];
    else if (s === 6) c = [245, 248, 255];
    else if (s === 5) c = [130, 128, 124];
    else if (s === 7) c = [220, 205, 160];
    const contour = h > 0 && Math.floor(h / 20) !== Math.floor(w.visAt(x + scale, z) / 20) ? 0.75 : 1;
    set(px, pz, Math.min(255, c[0] * shade * contour), Math.min(255, c[1] * shade * contour), Math.min(255, c[2] * shade * contour));
  }
}
const toPx = (x: number, z: number): [number, number] => [Math.round((x - x0) / scale), Math.round((z - z0) / scale)];
// buildings
const BC: Record<number, [number, number, number]> = { [BKind.OldTown]: [150, 80, 60], [BKind.Downtown]: [120, 110, 100], [BKind.Office]: [80, 110, 150], [BKind.Tower]: [40, 60, 120], [BKind.Apartment]: [170, 120, 90], [BKind.Villa]: [190, 140, 100], [BKind.Hall]: [110, 110, 120], [BKind.Chalet]: [120, 70, 40], [BKind.Farm]: [140, 90, 50], [BKind.Barn]: [110, 60, 40] };
for (const b of w.city.buildings) {
  const c = BC[b.kind] || [200, 30, 30];
  const s = Math.sin(b.rot), co = Math.cos(b.rot);
  const st = scale * 0.5;
  for (let lx = -b.w / 2; lx <= b.w / 2; lx += st)
    for (let lz = -b.d / 2; lz <= b.d / 2; lz += st) {
      const [px, pz] = toPx(b.x + co * lx + s * lz, b.z - s * lx + co * lz);
      const edge = Math.abs(lx) > b.w / 2 - scale || Math.abs(lz) > b.d / 2 - scale;
      set(px, pz, edge ? c[0] * 0.6 : c[0], edge ? c[1] * 0.6 : c[1], edge ? c[2] * 0.6 : c[2]);
    }
}
for (const t of w.city.trees) { const [px, pz] = toPx(t.x, t.z); if (scale <= 1) set(px, pz, t.type === 0 ? 20 : 40, t.type === 0 ? 70 : 100, 30); }
for (const p of w.city.parking) { const [px, pz] = toPx(p.x, p.z); set(px, pz, 255, 255, 0); }
for (const n of w.roads.nodes) {
  const [px, pz] = toPx(n.x, n.z);
  const c: [number, number, number] = n.edges.length === 1 ? [255, 0, 255] : n.signal ? [255, 220, 0] : [255, 40, 40];
  const r = n.edges.length === 1 ? 2 : 1;
  for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) set(px + a, pz + b, c[0], c[1], c[2]);
}
fs.writeFileSync(out, PNG.sync.write(png));

// stats
const deadEnds = w.roads.nodes.filter((n) => n.edges.length === 1).map((n) => `(${n.x.toFixed(0)},${n.z.toFixed(0)}) ${w.roads.edges[n.edges[0]].name}`);
console.log('dead ends:', deadEnds.length, '\n  ' + deadEnds.join('\n  '));
const grades = new Map<string, [number, string]>();
for (const e of w.roads.edges) {
  for (let i = 3; i < e.n; i++) {
    const g = Math.abs(e.py[i] - e.py[i - 3]) / (e.cum[i] - e.cum[i - 3]);
    if (g > (grades.get(e.name)?.[0] || 0)) grades.set(e.name, [g, `@(${e.px[i].toFixed(0)},${e.pz[i].toFixed(0)}) y${e.py[i - 3].toFixed(1)}→${e.py[i].toFixed(1)}`]);
  }
}
console.log('steep roads:', [...grades].filter(([, g]) => g[0] > 0.115).map(([n, g]) => `${n} ${(g[0] * 100).toFixed(0)}% ${g[1]}`).join('\n  '));
const hs = (id: string) => { const p = w.poi(id); return `${id}:${w.terrainAt(p.x, p.z).toFixed(0)}m`; };
console.log('heights', ['spawn', 'hb', 'uni', 'village', 'pass', 'uetli'].map(hs).join(' '));
let total = 0; for (const e of w.roads.edges) total += e.length;
console.log('road km', (total / 1000).toFixed(1));
void N; void RES;
