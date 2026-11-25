// In-game HUD: minimap, health, money, wanted level, speedometer, mission tracker, prompts, toasts, chat, banners.
import { MissionView } from '../../shared/net/protocol';
import type { Game, HudState } from '../game';
import { MapOverlay, MapView } from './mapview';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export const chf = (n: number) => Math.round(n).toLocaleString('de-CH');
const clock = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

export class Hud {
  readonly root = el('div');
  private map: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;
  private hp = el('i'); private hpBar = el('div', 'bar hp'); private st = el('i');
  private street = el('b'); private time = el('span');
  private money = el('div', 'money shadow');
  private stars = el('div', 'stars');
  private lvl = el('div', 'lvl caps shadow');
  private netInfo = el('div', 'net shadow');
  private assistChip = el('div', 'assist-chip shadow');
  private ammo = el('div', 'ammo shadow');
  private br = el('div', 'hud-br shadow');
  private speed = el('div', 'speed');
  private gear = el('div', 'gear');
  private rpm = el('i'); private rpmBar = el('div', 'rpm'); private vhp = el('i');
  private limit = el('div', 'limit');
  private vname = el('div', 'caps');
  private mission = el('div', 'mission shadow hidden');
  private prompt = el('div', 'prompt shadow');
  private cross = el('div', 'cross-hair');
  private toasts = el('div', 'toasts');
  private chatBox = el('div', 'chat shadow');
  private chatInput = el('input');
  private banner = el('div', 'banner');
  private count = el('div', 'count shadow hidden');
  private tags = new Map<number, HTMLDivElement>();
  private last: Partial<Record<string, string | number>> = {};
  private mapT = 0;
  private routeT = 0;
  private route: Float32Array | null = null;
  private routeKey = '';
  private bannerT = 0;
  overlay: MapOverlay = { x: 0, z: 0, yaw: 0, players: [], blips: [], target: null, waypoint: null, route: null, secrets: [], time: 0 };
  waypoint: { x: number; z: number } | null = null;
  showFps = false;
  blocked = new Set<number>();
  onChat: ((text: string) => void) | null = null;
  onChatOpen: ((open: boolean) => void) | null = null;
  game: Game | null = null;

  constructor(private mapView: MapView) {
    this.root.id = 'hud';
    const bl = el('div', 'hud-bl shadow');
    this.map = el('canvas');
    this.map.id = 'minimap';
    this.map.width = this.map.height = 228;
    this.mctx = this.map.getContext('2d')!;
    const bars = el('div', 'bars');
    this.hpBar.append(this.hp);
    const stBar = el('div', 'bar st');
    stBar.append(this.st);
    bars.append(this.hpBar, stBar);
    const where = el('div', 'where');
    where.append(this.street, this.time);
    bl.append(this.map, bars, where);
    const tr = el('div', 'hud-tr');
    for (let i = 0; i < 5; i++) this.stars.append(el('i'));
    tr.append(this.money, this.stars, this.lvl, this.ammo, this.assistChip, this.netInfo);
    const unit = el('div', 'speed-unit');
    unit.append(this.limit, this.gear, el('div', 'caps', 'km/h'));
    const sp = el('div');
    this.rpmBar.append(this.rpm);
    const vhpBar = el('div', 'vhp');
    vhpBar.append(this.vhp);
    sp.append(this.vname, this.speed, this.rpmBar, vhpBar);
    this.br.append(sp, unit);
    const tl = el('div', 'hud-tl');
    tl.append(this.mission);
    this.chatInput.type = 'text';
    this.chatInput.maxLength = 200;
    this.chatInput.placeholder = 'Nachricht …';
    this.chatBox.append(this.chatInput);
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') {
        const t = this.chatInput.value.trim();
        if (t) this.onChat?.(t);
        this.closeChat();
      } else if (e.code === 'Escape') this.closeChat();
    });
    this.chatInput.addEventListener('blur', () => this.closeChat());
    this.root.append(bl, tr, this.br, tl, this.prompt, this.cross, this.toasts, this.chatBox, this.count, this.banner);
  }

  show(on: boolean): void {
    this.root.classList.toggle('on', on);
  }
  openChat(): void {
    this.chatBox.classList.add('open');
    this.chatInput.value = '';
    this.chatInput.focus();
    this.onChatOpen?.(true);
  }
  closeChat(): void {
    if (!this.chatBox.classList.contains('open')) return;
    this.chatBox.classList.remove('open');
    this.chatInput.blur();
    this.onChatOpen?.(false);
  }
  get chatOpen(): boolean {
    return this.chatBox.classList.contains('open');
  }

  private set(key: string, v: string | number, fn: (v: string | number) => void): void {
    if (this.last[key] === v) return;
    this.last[key] = v;
    fn(v);
  }

  frame(s: HudState, dt = 1 / 60): void {
    const o = this.overlay;
    o.x = s.x; o.z = s.z; o.yaw = s.yaw; o.players = s.players.filter((p) => !this.blocked.has(p.id)); o.blips = s.blips; o.time += dt;
    o.target = s.mission ? { x: s.mission.x, z: s.mission.z } : null;
    o.waypoint = this.waypoint;
    // GPS route refresh
    this.routeT -= dt;
    const goal = o.target ?? o.waypoint;
    const key = goal ? `${Math.round(goal.x)},${Math.round(goal.z)}` : '';
    if (key !== this.routeKey || (goal && this.routeT <= 0)) {
      this.routeKey = key;
      this.routeT = 1.2;
      this.route = goal ? this.mapView.route(s.x, s.z, goal.x, goal.z) : null;
      if (this.waypoint && Math.hypot(this.waypoint.x - s.x, this.waypoint.z - s.z) < 14) { this.waypoint = null; this.route = null; }
    }
    o.route = this.route;
    // minimap ~30 Hz
    this.mapT -= dt;
    if (this.mapT <= 0) {
      this.mapT = 0.033;
      const radius = s.inVehicle ? 170 + Math.min(150, s.speedKmh * 1.1) : 120;
      this.mapView.drawMini(this.mctx, this.map.width, o, s.camYaw, radius);
    }
    this.set('hp', Math.round(s.hp), (v) => { this.hp.style.width = `${v}%`; this.hpBar.classList.toggle('low', (v as number) < 30); });
    this.set('st', Math.round(s.stamina * 50), (v) => { this.st.style.width = `${(v as number) * 2}%`; });
    this.set('street', s.street || s.zone, (v) => { this.street.textContent = String(v); });
    this.set('time', clock(s.hours), (v) => { this.time.textContent = String(v); });
    this.set('money', Math.round(s.money), (v) => { this.money.innerHTML = `<small>CHF</small>${chf(v as number)}`; });
    this.set('wanted', s.wanted, (v) => { [...this.stars.children].forEach((c, i) => c.classList.toggle('on', i < (v as number))); this.stars.style.visibility = v ? 'visible' : 'hidden'; });
    this.set('lvl', `${s.level}|${Math.round((s.xpCur / s.xpNeed) * 40)}`, () => { this.lvl.innerHTML = `Level ${s.level}<span class="xp"><i style="width:${(s.xpCur / s.xpNeed) * 100}%"></i></span>`; });
    this.set('ammo', s.inVehicle ? '' : s.weapon ? `PISTOLE  ${s.ammo}` : 'FAUST', (v) => { this.ammo.textContent = String(v); });
    if (this.showFps || s.online) this.set('net', `${Math.round(s.fps)} FPS${s.online ? ` · ${Math.round(s.ping)} ms` : ''}`, (v) => { this.netInfo.textContent = String(v); });
    else this.set('net', '', () => { this.netInfo.textContent = ''; });
    this.set('assist', s.assist, (v) => { this.assistChip.textContent = String(v); this.assistChip.style.display = v ? 'block' : 'none'; });
    // vehicle cluster
    this.set('veh', s.inVehicle ? 1 : 0, (v) => { this.br.style.display = v ? 'flex' : 'none'; });
    if (s.inVehicle) {
      this.set('speed', Math.round(s.speedKmh), (v) => { this.speed.textContent = String(v); });
      this.set('gear', s.driving ? (s.gear <= 0 ? 'R' : s.speedKmh < 1 ? 'N' : String(s.gear)) : '', (v) => { this.gear.textContent = String(v); });
      this.set('rpm', Math.round(s.rpm * 50), (v) => { this.rpm.style.width = `${(v as number) * 2}%`; this.rpmBar.classList.toggle('red', (v as number) > 46); });
      this.set('vhp', Math.round(s.vehicleHp * 25), (v) => { this.vhp.style.width = `${(v as number) * 4}%`; this.vhp.style.background = (v as number) < 8 ? 'var(--red)' : (v as number) < 15 ? 'var(--amber)' : 'var(--green)'; });
      this.set('vname', s.vehicleName, (v) => { this.vname.textContent = String(v); });
      this.set('limit', s.speedLimit, (v) => { this.limit.style.visibility = v ? 'visible' : 'hidden'; this.limit.textContent = String(v); });
    }
    // mission tracker
    const m = s.mission;
    this.set('mis', m ? `${m.id}|${m.text}|${m.info ?? ''}|${m.kind === 'race' ? m.timer.toFixed(1) : Math.ceil(m.timer)}` : '', () => {
      this.mission.classList.toggle('hidden', !m);
      if (!m) return;
      this.mission.className = `mission shadow ${m.kind}`;
      const timer = m.timer >= 0 && m.info !== 'countdown' ? (m.kind === 'race' ? `${m.timer.toFixed(1)} s` : mmss(m.timer)) : '';
      const warn = m.kind !== 'race' && m.timer >= 0 && m.timer < 30;
      this.mission.innerHTML = `<div class="mt caps">${esc(m.title)}${m.steps > 1 && m.kind !== 'race' ? ` · ${Math.min(m.step, m.steps)}/${m.steps}` : ''}</div><div class="mo">${esc(m.text)}</div><div class="mi">${timer ? `<span class="${warn ? 'warn' : ''}">${timer}</span>` : ''}${m.info && m.info !== 'countdown' && m.info !== 'stopwatch' ? `<span>${esc(m.info)}</span>` : ''}</div>`;
    });
    const cd = m && m.info === 'countdown' ? m.text.replace(/\D/g, '') : '';
    this.set('count', cd, (v) => { this.count.classList.toggle('hidden', !v); this.count.textContent = String(v); });
    this.set('prompt', s.dead ? '' : s.prompt, (v) => {
      const t = String(v);
      const i = t.indexOf('  ');
      this.prompt.innerHTML = t ? `<span class="key">${esc(t.slice(0, i))}</span>${esc(t.slice(i + 2))}` : '';
    });
    this.set('aim', s.aiming ? 1 : 0, (v) => this.cross.classList.toggle('on', !!v));
    // name tags
    if (this.game) {
      const pos = _pos;
      const seen = new Set<number>();
      for (const p of s.players) {
        if (this.blocked.has(p.id)) continue;
        this.game.screenPos(p.id, pos);
        if (!pos.visible) continue;
        seen.add(p.id);
        let t = this.tags.get(p.id);
        if (!t) { t = el('div', 'tag shadow'); this.root.append(t); this.tags.set(p.id, t); }
        if (t.textContent !== p.name) t.textContent = p.name;
        t.style.left = `${pos.x}px`;
        t.style.top = `${pos.y}px`;
      }
      for (const [id, t] of this.tags) if (!seen.has(id)) { t.remove(); this.tags.delete(id); }
    }
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.banner.classList.remove('on');
    }
  }

  toast(text: string, kind = 'info'): void {
    const t = el('div', `toast ${kind}`);
    t.textContent = text;
    this.toasts.append(t);
    while (this.toasts.children.length > 5) this.toasts.firstChild!.remove();
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4700);
  }
  chat(name: string, text: string, sys: boolean, from = 0): void {
    if (from && this.blocked.has(from)) return;
    const l = el('div', `line${sys ? ' sys' : ''}`);
    l.innerHTML = sys ? esc(text) : `<b>${esc(name)}</b>  ${esc(text)}`;
    this.chatBox.insertBefore(l, this.chatInput);
    const lines = this.chatBox.querySelectorAll('.line');
    if (lines.length > 9) lines[0].remove();
    setTimeout(() => l.classList.add('old'), 9000);
  }
  showBanner(title: string, cls: string, sub = '', big = '', seconds = 4): void {
    this.banner.innerHTML = `<div><h2 class="${cls} shadow">${esc(title)}</h2>${big ? `<div class="big shadow">${esc(big)}</div>` : ''}${sub ? `<p class="shadow">${esc(sub)}</p>` : ''}</div>`;
    this.banner.classList.add('on');
    this.bannerT = seconds;
  }
  missionResult(_m: MissionView | null, r?: { ok: boolean; title: string; reward: number; xp: number; detail?: string }): void {
    if (!r) return;
    this.showBanner(r.title, r.ok ? 'amber' : 'red', r.detail ?? '', r.ok && r.reward ? `+ CHF ${chf(r.reward)}   ·   + ${r.xp} XP` : '', 5);
  }
  wasted(busted: boolean, fee: number): void {
    this.showBanner(busted ? 'Verhaftet' : 'Erledigt', 'red', busted ? 'Die Kantonspolizei lässt grüssen.' : 'Das Universitätsspital hat dich zusammengeflickt.', fee ? `− CHF ${chf(fee)}` : '', 4.2);
  }
}
const _pos = { x: 0, y: 0, visible: false };
