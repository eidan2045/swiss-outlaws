// Application shell: boot, menus, settings, online flow (accounts, lobbies, friends) and the game session lifecycle.
import * as THREE from 'three';
import { buildWorld, World } from '../shared/world/world';
import { Appearance, FriendInfo, LobbyInfo, MissionView, Profile, ServerMsg } from '../shared/net/protocol';
import { VEHICLES } from '../shared/sim/types';
import { ACTIVITIES, SECRETS } from '../shared/sim/missions';
import { Engine } from './render/engine';
import { WorldView } from './render/worldview';
import { QUALITIES, QualityName } from './render/globals';
import { LoopbackTransport, NetClient, WsTransport } from './net/client';
import { Input, MenuAction } from './input/input';
import { Game, GameUi, HudState } from './game';
import { AudioSystem } from './audio/audio';
import { Hud, chf, el, esc } from './ui/hud';
import { MapView } from './ui/mapview';
import { CharacterModel, HAIR, JACKET, PANTS, SHOES, SKIN } from './entities/charactermodel';
import { Settings, loadProfile, loadSettings, saveProfile, saveSettings } from './settings';
import './ui/style.css';

declare const __SINGLE_FILE__: boolean;
const VERSION = '0.1.0 · Vertical Slice';

interface Screen {
  el: HTMLElement;
  back?: () => void;
  tab?: (dir: number) => void;
  key?: (a: MenuAction) => boolean;
  tick?: (dt: number) => void;
  onShow?: () => void;
}

export class App implements GameUi {
  private ui = document.getElementById('ui') as HTMLDivElement;
  private canvas = document.getElementById('game') as HTMLCanvasElement;
  private settings: Settings = loadSettings();
  private engine!: Engine;
  private world!: World;
  private view!: WorldView;
  private input!: Input;
  private mapView!: MapView;
  private hud!: Hud;
  private audio = new AudioSystem();
  private game: Game | null = null;
  private net: NetClient | null = null;
  private screen: Screen | null = null;
  private stack: Screen[] = [];
  private focusEl: HTMLElement | null = null;
  private account: { id: string; name: string; guest: boolean } | null = null;
  private friends: FriendInfo[] = [];
  private requests: { id: string; name: string }[] = [];
  private lobbies: LobbyInfo[] = [];
  private lobbyCode = '';
  private serverUrl = '';
  private sameOrigin = false;
  private preview: CharacterModel | null = null;
  private menuT = 0;
  private last = performance.now();
  private fpsWin = { t: 0, n: 0 };
  private autoQ: QualityName = 'high';
  private reconnecting = false;
  private refreshOnline: (() => void) | null = null;
  private authMsg: ((text: string) => void) | null = null;
  private paused = false;
  private dbg: Record<string, unknown> = {};
  /** automated tests can skip drawing to keep the simulation at full speed on software renderers */
  private noRender = new URLSearchParams(location.search).has('norender');

  // ================================================================= boot
  async boot(): Promise<void> {
    const loading = el('div', 'screen on');
    loading.id = 'loading';
    loading.innerHTML = `<h1 class="mark">Swiss<br>Outlaws<span class="cross"></span></h1><div class="caps" id="ld-t">Welt wird erzeugt …</div><div class="bar"><i id="ld-b"></i></div>`;
    this.ui.append(loading);
    const bar = loading.querySelector('#ld-b') as HTMLElement, txt = loading.querySelector('#ld-t') as HTMLElement;
    const step = async (label: string, f: number) => {
      txt.textContent = label;
      bar.style.width = `${f * 100}%`;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    };
    const params = new URLSearchParams(location.search);
    await step('Gelände, Strassen und Gebäude werden erzeugt …', 0.12);
    this.world = buildWorld();
    await step('Grafik wird vorbereitet …', 0.55);
    const q = (params.get('q') as QualityName) || (this.settings.quality === 'auto' ? this.autoQ : this.settings.quality);
    this.engine = new Engine(this.canvas, QUALITIES[q] ? q : 'high');
    this.engine.resScale = this.settings.resScale;
    this.view = new WorldView(this.engine, this.world);
    await step('Stadt wird aufgebaut …', 0.8);
    this.mapView = new MapView(this.world);
    this.hud = new Hud(this.mapView);
    this.hud.showFps = this.settings.showFps;
    this.ui.append(this.hud.root);
    this.input = new Input(this.canvas);
    this.applySettings();
    this.input.onMenu = (a) => this.menuKey(a);
    this.hud.onChat = (t) => this.net?.command({ k: 'chat', text: t });
    this.hud.onChatOpen = (open) => { this.input.uiMode = open || this.screen !== null; if (!open && this.game && !this.screen) this.input.requestLock(); };
    this.canvas.addEventListener('click', () => { this.audio.unlock(); if (this.game && !this.screen && !this.hud.chatOpen) this.input.requestLock(); });
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: false });
    window.addEventListener('keydown', (e) => {
      this.audio.unlock();
      if (!(e.target instanceof HTMLInputElement) && !e.repeat) this.keysOnce.add(e.code);
    });
    document.addEventListener('pointerlockchange', () => {
      // leaving pointer lock with Esc opens the pause menu
      if (!document.pointerLockElement && this.game && !this.screen && !this.hud.chatOpen && this.input.device === 'kbm') this.openPause();
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.game && !this.screen) this.openPause(); });
    // server discovery
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    this.serverUrl = params.get('server') || this.settings.serverUrl || env?.VITE_SERVER_URL || '';
    if (!this.serverUrl && location.protocol.startsWith('http')) {
      try {
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 2500);
        const r = await fetch('/health', { signal: ctl.signal });
        const j = await r.json();
        if (j && j.name === 'swiss-outlaws') { this.sameOrigin = true; this.serverUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`; }
      } catch { /* static hosting without a game server */ }
    }
    await step('Bereit', 1);
    // pre-warm the area around the city centre for the menu fly-over
    this.engine.camera.position.set(-200, 120, 700);
    this.engine.camera.lookAt(-120, 20, 0);
    loading.classList.remove('on');
    setTimeout(() => loading.remove(), 400);
    (window as unknown as { __dbg: unknown }).__dbg = this.dbg = { app: this, engine: this.engine, world: this.world, view: this.view, input: this.input, frames: 0, fps: 0 };
    requestAnimationFrame((t) => this.loop(t));
    const code = params.get('join');
    if (params.has('play')) this.startOffline();
    else if (code && this.serverUrl) { this.lobbyCode = code.toUpperCase(); this.show(this.titleScreen()); this.openOnline(); }
    else this.show(this.titleScreen());
  }

  private applySettings(): void {
    const s = this.settings;
    this.audio.setVolumes(s.master, s.music, s.sfx);
    this.audio.music(true);
    if (this.input) Object.assign(this.input.settings, { mouseSens: s.mouseSens, padSens: s.padSens, deadzone: s.deadzone, invertY: s.invertY, vibration: s.vibration });
    if (this.hud) this.hud.showFps = s.showFps;
    saveSettings(s);
  }
  private setQuality(q: QualityName): void {
    if (this.engine.quality.name === q) return;
    this.engine.setQuality(q);
    this.view.sky.setQuality(this.engine.quality);
    this.view.terrain.setQuality(this.engine.quality);
    this.view.scenery.setQuality(this.engine.quality);
  }

  // ================================================================= main loop
  private loop(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.game) {
      if (this.paused && this.net?.transport.kind === 'local') {
        this.input.poll(dt);
        this.screen?.tick?.(dt);
      } else {
        this.game.update(dt);
        this.screen?.tick?.(dt);
        if (!this.screen && !this.hud.chatOpen) {
          if (this.input.pausePressed) this.openPause();
          else if (this.input.mapPressed) this.openMap();
          else if (this.input.chatPressed) this.hud.openChat();
          else if (this.game.hud.nearActivity?.kind === 'dealer' && !this.game.hud.inVehicle && (this.keyOnce('KeyB') || this.padOnce(4))) this.show(this.dealerScreen());
          else if (this.game.hud.nearActivity?.kind === 'garage' && this.game.hud.driving && (this.keyOnce('KeyR') || this.padOnce(5))) this.net?.command({ k: 'buy', item: 'repair' });
        }
        if (this.game.effects.flash > 0.9) this.audio.thunder();
      }
    } else {
      // menu backdrop: slow fly-over of the city and the lake
      this.input.poll(dt);
      this.menuT += dt;
      const cam = this.engine.camera;
      if (this.preview) {
        const p = this.preview.group.position;
        const a = 0.5 + Math.sin(this.menuT * 0.25) * 0.25;
        cam.position.set(p.x + Math.sin(a) * 3.1, p.y + 1.45, p.z + Math.cos(a) * 3.1);
        cam.lookAt(p.x - 0.75, p.y + 1.02, p.z);
        this.preview.update(dt, PREVIEW_ANIM, p.x, p.y, p.z, 0.35 + Math.sin(this.menuT * 0.4) * 0.25);
      } else {
        const a = this.menuT * 0.02 + 2.4;
        cam.position.set(-60 + Math.sin(a) * 620, 95 + Math.sin(this.menuT * 0.05) * 25, 80 + Math.cos(a) * 620);
        cam.lookAt(-60, 18, 40);
      }
      if (cam.fov !== 50) { cam.fov = 50; cam.updateProjectionMatrix(); }
      this.view.hours = 17.2 + Math.sin(this.menuT * 0.01) * 0.6;
      this.view.update(dt, _focus.set(cam.position.x, 20, cam.position.z).lerp(_zero, 0.4));
      this.screen?.tick?.(dt);
      this.audio.idle();
    }
    if (!this.noRender) this.engine.render(dt);
    // automatic quality: step down when the frame rate stays low
    this.fpsWin.t += dt; this.fpsWin.n++;
    if (this.fpsWin.t >= 2.5) {
      const fps = this.fpsWin.n / this.fpsWin.t;
      this.fpsWin.t = 0; this.fpsWin.n = 0;
      if (this.settings.quality === 'auto' && fps < 38 && !document.hidden && !this.noRender) {
        const order: QualityName[] = ['low', 'medium', 'high', 'ultra'];
        const i = order.indexOf(this.engine.quality.name);
        if (i > 0) { this.setQuality(order[i - 1]); this.autoQ = order[i - 1]; this.hud.toast(`Grafikprofil automatisch angepasst: ${order[i - 1]}`, 'info'); }
      }
      this.dbg.fps = fps;
    }
    this.dbg.frames = ((this.dbg.frames as number) || 0) + 1;
    this.keysOnce.clear();
    requestAnimationFrame((t) => this.loop(t));
  }
  private keysOnce = new Set<string>();
  private keyOnce(code: string): boolean {
    return this.keysOnce.has(code);
  }
  private prevPad: boolean[] = [];
  private padOnce(i: number): boolean {
    const pad = (navigator.getGamepads?.() ?? []).find((g) => g);
    if (!pad) return false;
    const now = !!pad.buttons[i]?.pressed, was = this.prevPad[i];
    this.prevPad[i] = now;
    return now && !was;
  }

  // ================================================================= screen management
  private show(s: Screen | null, push = false): void {
    if (this.screen) {
      const old = this.screen;
      old.el.classList.remove('on');
      setTimeout(() => old.el.remove(), 300);
      if (push) this.stack.push(old);
    }
    if (!push && s === null) this.stack.length = 0;
    this.screen = s;
    this.focusEl = null;
    this.input.flush();
    this.keysOnce.clear();
    if (s) {
      this.ui.append(s.el);
      void s.el.offsetWidth;
      s.el.classList.add('on');
      s.el.addEventListener('mousemove', (e) => {
        const f = (e.target as HTMLElement).closest?.('.f') as HTMLElement | null;
        if (f && f !== this.focusEl) this.focus(f, false);
      });
      s.onShow?.();
      const first = s.el.querySelector('.f.start') ?? s.el.querySelector('.f:not([disabled])');
      if (first) this.focus(first as HTMLElement, false);
      this.input.uiMode = true;
      this.input.exitLock();
    } else {
      this.input.uiMode = false;
      this.paused = false;
      if (this.game) { this.input.requestLock(); }
    }
    this.hud.show(!!this.game && (!s || s.el.id === ''));
  }
  private pop(): void {
    const prev = this.stack.pop();
    if (prev) {
      const cur = this.screen;
      if (cur) { cur.el.classList.remove('on'); setTimeout(() => cur.el.remove(), 300); }
      this.screen = null;
      this.show(prev);
    } else if (this.game) this.show(null);
  }
  private focus(e: HTMLElement, sound = true): void {
    this.focusEl?.classList.remove('focus');
    this.focusEl = e;
    e.classList.add('focus');
    e.scrollIntoView({ block: 'nearest' });
    if (sound) this.audio.ui('move');
    const info = e.dataset.info;
    const panel = this.screen?.el.querySelector('.info');
    if (panel && info !== undefined) panel.innerHTML = info;
  }
  private menuKey(a: MenuAction): void {
    const s = this.screen;
    if (!s) return;
    if (document.activeElement instanceof HTMLInputElement && (a === 'left' || a === 'right' || a === 'confirm' && document.activeElement.type !== 'range')) {
      if (a === 'confirm') (document.activeElement as HTMLElement).blur();
      return;
    }
    if (s.key?.(a)) return;
    const items = [...s.el.querySelectorAll<HTMLElement>('.f')].filter((x) => x.offsetParent !== null && !x.hasAttribute('disabled'));
    const i = this.focusEl ? items.indexOf(this.focusEl) : -1;
    if (a === 'up' || a === 'down') {
      if (!items.length) return;
      const cur = this.focusEl;
      // in grids / rows move geometrically, in lists by order
      if (cur && (cur.classList.contains('card') || cur.classList.contains('mini'))) {
        const r = cur.getBoundingClientRect();
        let best: HTMLElement | null = null, bd = 1e9;
        for (const it of items) {
          const q = it.getBoundingClientRect();
          const dy = q.top - r.top;
          if ((a === 'down' && dy > 4) || (a === 'up' && dy < -4)) {
            const d = Math.abs(dy) * 2 + Math.abs(q.left - r.left);
            if (d < bd) { bd = d; best = it; }
          }
        }
        if (best) this.focus(best);
        return;
      }
      const n = a === 'down' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      if (items[n] !== cur) this.focus(items[n]);
    } else if (a === 'left' || a === 'right') {
      const cur = this.focusEl;
      const d = a === 'right' ? 1 : -1;
      if (!cur) return;
      if (cur.classList.contains('opt')) {
        const range = cur.querySelector<HTMLInputElement>('input[type=range]');
        if (range) {
          const stepV = Number(range.step) || 1;
          range.value = String(Math.max(Number(range.min), Math.min(Number(range.max), Number(range.value) + d * stepV * 2)));
          range.dispatchEvent(new Event('input'));
        } else {
          const btns = [...cur.querySelectorAll<HTMLButtonElement>('.seg button, .swatches button')];
          const on = btns.findIndex((b) => b.classList.contains('on'));
          const n = Math.max(0, Math.min(btns.length - 1, on + d));
          if (n !== on) btns[n].click();
        }
        this.audio.ui('move');
      } else if (cur.classList.contains('card') || cur.classList.contains('mini') || cur.classList.contains('btn')) {
        const n = Math.max(0, Math.min(items.length - 1, i + d));
        if (items[n] !== cur) this.focus(items[n]);
      }
    } else if (a === 'confirm') {
      const cur = this.focusEl;
      if (!cur) return;
      this.audio.ui('select');
      if (cur instanceof HTMLInputElement) cur.focus();
      else if (cur.classList.contains('opt')) {
        const btns = [...cur.querySelectorAll<HTMLButtonElement>('.seg button')];
        if (btns.length) { const on = btns.findIndex((b) => b.classList.contains('on')); btns[(on + 1) % btns.length].click(); }
      } else cur.click();
    } else if (a === 'back' || a === 'pause') {
      this.audio.ui('back');
      if (s.back) s.back();
      else this.pop();
    } else if (a === 'tabL' || a === 'tabR') s.tab?.(a === 'tabR' ? 1 : -1);
    else if (a === 'map' && s.el.id === 'bigmap') this.show(null);
  }

  // ---- small builders
  private item(ix: string, title: string, fn: () => void, opts: { right?: string; info?: string; small?: boolean; disabled?: boolean; start?: boolean } = {}): HTMLButtonElement {
    const b = el('button', `item f${opts.small ? ' small' : ''}${opts.start ? ' start' : ''}`, `<span class="ix">${ix}</span><span class="t">${esc(title)}</span>${opts.right ? `<span class="r">${opts.right}</span>` : ''}`);
    if (opts.info !== undefined) b.dataset.info = opts.info;
    if (opts.disabled) b.setAttribute('disabled', '');
    b.addEventListener('click', () => { if (!b.hasAttribute('disabled')) fn(); });
    return b;
  }
  private menu(id: string, title: string, crumb: string, scrim = 'scrim-left'): { s: Screen; body: HTMLElement; footer: HTMLElement; header: HTMLElement } {
    const root = el('div', `screen menu ${scrim}`);
    root.id = id;
    const header = el('header', '', `<h1>${title}</h1><span class="crumb caps">${crumb}</span>`);
    const body = el('div', 'body');
    const footer = el('footer', 'caps');
    footer.innerHTML = this.hints(['↑↓|LS', 'Wählen'], ['Enter|A', 'OK'], ['Esc|B', 'Zurück']);
    root.append(header, body, footer);
    return { s: { el: root }, body, footer, header };
  }
  private hints(...h: [string, string][]): string {
    const pad = this.input?.device === 'pad';
    return h.map(([k, t]) => `<span><span class="key">${esc(k.split('|')[pad ? 1 : 0] ?? k)}</span>${esc(t)}</span>`).join('');
  }
  private slider(name: string, min: number, max: number, stepV: number, value: number, fmt: (v: number) => string, on: (v: number) => void): HTMLElement {
    const o = el('div', 'opt f', `<span class="name">${name}</span><input type="range" min="${min}" max="${max}" step="${stepV}" value="${value}"><span class="val">${fmt(value)}</span>`);
    const r = o.querySelector('input')!, v = o.querySelector('.val')!;
    r.addEventListener('input', () => { v.textContent = fmt(Number(r.value)); on(Number(r.value)); });
    return o;
  }
  private seg(name: string, options: [string, string][], value: string, on: (v: string) => void): HTMLElement {
    const o = el('div', 'opt f', `<span class="name">${name}</span><div class="seg"></div><span class="val"></span>`);
    const segEl = o.querySelector('.seg')!;
    for (const [val, label] of options) {
      const b = el('button', val === value ? 'on' : '', esc(label));
      b.addEventListener('click', () => { segEl.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); on(val); });
      segEl.append(b);
    }
    return o;
  }
  private swatch(name: string, colors: number[], value: number, on: (v: number) => void): HTMLElement {
    const o = el('div', 'opt f', `<span class="name">${name}</span><div class="swatches"></div><span class="val"></span>`);
    const sw = o.querySelector('.swatches')!;
    colors.forEach((c, i) => {
      const b = el('button', i === value ? 'on' : '');
      b.style.background = `#${c.toString(16).padStart(6, '0')}`;
      b.addEventListener('click', () => { sw.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); on(i); });
      sw.append(b);
    });
    return o;
  }

  // ================================================================= title + main menu
  private titleScreen(): Screen {
    const root = el('div', 'screen scrim-left');
    root.id = 'title';
    root.innerHTML = `<div class="caps shadow">Open-World-Multiplayer · Schweiz</div><div><h1 class="mark shadow">Swiss<br>Outlaws<span class="cross"></span><small>Zürich · Limmat · Uetliberg · Passhöhe</small></h1></div><div class="press caps shadow"><span class="key">Enter</span> oder <span class="key">A</span> drücken</div><div class="ver caps">${VERSION}</div>`;
    const go = () => { this.audio.unlock(); this.audio.ui('select'); this.show(this.mainMenu()); };
    root.addEventListener('click', go);
    return { el: root, key: (a) => { if (a === 'confirm' || a === 'pause') go(); return true; }, back: () => {} };
  }
  private mainMenu(): Screen {
    const { s, body } = this.menu('main', 'Swiss Outlaws', 'Hauptmenü');
    const list = el('div', 'col list');
    const info = el('div', 'col wide panel info shadow');
    const online = this.serverUrl ? 'Mit Freunden in einer gemeinsamen Welt spielen: Konten, Freundesliste, öffentliche und private Lobbys.' : 'Mit Freunden spielen. Es ist noch kein Spielserver hinterlegt – die Adresse kann im nächsten Schritt eingetragen werden.';
    list.append(
      this.item('01', 'Einzelspieler', () => this.startOffline(), { info: `<h2 class="caps">Einzelspieler</h2><p>Freies Spiel in der offenen Welt – läuft komplett in deinem Browser, Fortschritt wird lokal gespeichert.</p>`, start: true }),
      this.item('02', 'Online spielen', () => this.openOnline(), { info: `<h2 class="caps">Online</h2><p>${online}</p>` }),
      this.item('03', 'Charakter', () => this.show(this.characterScreen(), true), { info: `<h2 class="caps">Charakter</h2><p>Aussehen und Kleidung deiner Spielfigur anpassen.</p>` }),
      this.item('04', 'Einstellungen', () => this.show(this.settingsScreen(), true), { info: `<h2 class="caps">Einstellungen</h2><p>Grafikprofile von Low bis Ultra, Lautstärke, Maus- und Controller-Empfindlichkeit.</p>` }),
      this.item('05', 'Steuerung', () => this.show(this.controlsScreen(), true), { info: `<h2 class="caps">Steuerung</h2><p>Tastatur &amp; Maus sowie Xbox-Controller.</p>` }),
      this.item('06', 'Über das Spiel', () => this.show(this.aboutScreen(), true), { info: `<h2 class="caps">Über</h2><p>Stand der Entwicklung, Lizenzen und Hinweise zur Xbox-Nutzung.</p>` }),
    );
    body.append(list, info);
    s.back = () => this.show(this.titleScreen());
    return s;
  }

  private characterScreen(): Screen {
    const { s, body } = this.menu('char', 'Charakter', 'Aussehen');
    const col = el('div', 'col list');
    const a = this.settings.appearance;
    const apply = () => {
      saveSettings(this.settings);
      this.setPreview(true);
      if (this.game && this.net) {
        this.net.profile.appearance = { ...a };
        this.net.sendRaw({ t: 'appearance', a });
        this.game.setAppearance();
      }
    };
    const name = el('div', 'field f', `<label class="caps">Name (offline)</label>`);
    const inp = el('input');
    inp.type = 'text'; inp.maxLength = 16; inp.value = this.settings.name;
    inp.addEventListener('input', () => { this.settings.name = inp.value.trim().slice(0, 16); saveSettings(this.settings); });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    name.append(inp);
    name.addEventListener('click', () => inp.focus());
    col.append(
      name,
      this.swatch('Haut', SKIN, a.skin, (v) => { a.skin = v; apply(); }),
      this.seg('Frisur', [['0', 'Kurz'], ['1', 'Lang'], ['3', 'Voll'], ['2', 'Glatze']], String(a.hairStyle), (v) => { a.hairStyle = Number(v); apply(); }),
      this.swatch('Haarfarbe', HAIR, a.hair, (v) => { a.hair = v; apply(); }),
      this.seg('Kopfbedeckung', [['0', 'Keine'], ['1', 'Cap']], String(a.hat), (v) => { a.hat = Number(v); apply(); }),
      this.swatch('Jacke', JACKET, a.jacket, (v) => { a.jacket = v; apply(); }),
      this.swatch('Hose', PANTS, a.pants, (v) => { a.pants = v; apply(); }),
      this.swatch('Schuhe', SHOES, a.shoes, (v) => { a.shoes = v; apply(); }),
      this.seg('Statur', [['0', 'Schlank'], ['1', 'Mittel'], ['2', 'Kräftig']], String(a.build), (v) => { a.build = Number(v); apply(); }),
    );
    body.append(col);
    s.onShow = () => this.setPreview(true);
    s.back = () => { this.setPreview(false); this.pop(); };
    return s;
  }
  private setPreview(on: boolean): void {
    if (this.preview) { this.engine.scene.remove(this.preview.group); this.preview = null; }
    if (!on || this.game) return;
    this.preview = new CharacterModel(this.settings.appearance);
    const x = -150, z = 346;
    this.preview.group.position.set(x, this.world.groundAt(x, z), z);
    this.engine.scene.add(this.preview.group);
  }

  private settingsScreen(inGame = false): Screen {
    const { s, body } = this.menu('settings', 'Einstellungen', inGame ? 'Pause' : 'Hauptmenü', inGame ? 'scrim' : 'scrim-left');
    const col = el('div', 'col wide');
    col.style.maxWidth = '760px';
    const st = this.settings;
    const pct = (v: number) => `${Math.round(v * 100)} %`;
    const head = (t: string) => el('h2', 'caps', t);
    col.append(
      head('Grafik'),
      this.seg('Profil', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], st.quality, (v) => { st.quality = v as Settings['quality']; if (v !== 'auto') this.setQuality(v as QualityName); this.applySettings(); }),
      this.slider('Auflösung', 0.5, 1.5, 0.05, st.resScale, pct, (v) => { st.resScale = v; this.engine.resScale = v; this.engine.resize(); this.applySettings(); }),
      this.seg('FPS-Anzeige', [['0', 'Aus'], ['1', 'Ein']], st.showFps ? '1' : '0', (v) => { st.showFps = v === '1'; this.applySettings(); }),
      head('Audio'),
      this.slider('Gesamt', 0, 1, 0.05, st.master, pct, (v) => { st.master = v; this.applySettings(); }),
      this.slider('Musik', 0, 1, 0.05, st.music, pct, (v) => { st.music = v; this.applySettings(); }),
      this.slider('Effekte', 0, 1, 0.05, st.sfx, pct, (v) => { st.sfx = v; this.applySettings(); }),
      head('Steuerung'),
      this.slider('Maus', 0.2, 3, 0.05, st.mouseSens, (v) => v.toFixed(2), (v) => { st.mouseSens = v; this.applySettings(); }),
      this.slider('Controller', 0.2, 3, 0.05, st.padSens, (v) => v.toFixed(2), (v) => { st.padSens = v; this.applySettings(); }),
      this.slider('Deadzone', 0.02, 0.4, 0.01, st.deadzone, (v) => v.toFixed(2), (v) => { st.deadzone = v; this.applySettings(); }),
      this.seg('Y-Achse', [['0', 'Normal'], ['1', 'Invertiert']], st.invertY ? '1' : '0', (v) => { st.invertY = v === '1'; this.applySettings(); }),
      this.seg('Vibration', [['1', 'Ein'], ['0', 'Aus']], st.vibration ? '1' : '0', (v) => { st.vibration = v === '1'; this.applySettings(); }),
    );
    for (const h of col.querySelectorAll('h2')) (h as HTMLElement).style.margin = '18px 0 4px';
    body.append(col);
    return s;
  }
  private controlsScreen(inGame = false): Screen {
    const { s, body } = this.menu('controls', 'Steuerung', 'Tastatur · Maus · Xbox', inGame ? 'scrim' : 'scrim-left');
    const rows: [string, string, string][] = [
      ['Bewegen / Lenken', 'W A S D', 'Linker Stick'], ['Kamera', 'Maus', 'Rechter Stick'], ['Sprinten', 'Shift', 'A halten'], ['Springen / Klettern', 'Leertaste', 'X'],
      ['Ducken', 'C', 'Steuerkreuz ↓'], ['Zielen', 'Rechte Maustaste', 'LT'], ['Schiessen', 'Linke Maustaste', 'RT'], ['Schlagen', 'Q', 'B'],
      ['Waffe wechseln', 'X oder 1', 'Steuerkreuz ↑'], ['Ein-/Aussteigen · Interagieren', 'E', 'Y'], ['Gas / Bremse', 'W / S', 'RT / LT'], ['Handbremse', 'Leertaste', 'A oder RB'],
      ['Hupe', 'H', 'L3'], ['Licht / Sirene', 'L / G', 'Steuerkreuz → / ←'], ['Kameraabstand', 'V', 'R3'], ['Karte', 'M', 'Ansicht-Taste'],
      ['Chat', 'T oder Enter', '—'], ['Pause', 'Esc oder P', 'Menü-Taste'],
    ];
    const dl = el('dl', 'help');
    dl.style.gridTemplateColumns = 'auto auto auto';
    dl.innerHTML = `<dd class="caps">Aktion</dd><dd class="caps">Tastatur &amp; Maus</dd><dd class="caps">Xbox-Controller</dd>` + rows.map((r) => `<dt style="text-align:left">${r[0]}</dt><dd><span class="key">${r[1]}</span></dd><dd><span class="key">${r[2]}</span></dd>`).join('');
    const col = el('div', 'col wide');
    col.append(dl);
    const b = el('button', 'btn ghost f', 'Zurück');
    b.style.cssText = 'align-self:flex-start;margin-top:22px';
    b.addEventListener('click', () => this.pop());
    col.append(b);
    body.append(col);
    return s;
  }
  private aboutScreen(): Screen {
    const { s, body } = this.menu('about', 'Über', VERSION);
    const col = el('div', 'col wide panel');
    col.innerHTML = `<p><b>Swiss Outlaws</b> ist ein eigenständiges Open-World-Spiel in einer komprimierten, fiktionalisierten Schweiz. Alle Modelle, Texturen, Klänge und die Musik werden prozedural im Browser erzeugt – es werden keine fremden Assets verwendet.</p>
<p><b>Xbox:</b> Das Spiel läuft als Web-Anwendung und kann mit einem Xbox-Controller bedient werden; in Microsoft Edge auf der Xbox ist es eine Browser-Anwendung, kein natives Konsolenspiel.</p>
<p><b>Technik:</b> Three.js (MIT), TypeScript, Vite. Server: Node.js + WebSocket, autoritative Simulation.</p>`;
    const b = el('button', 'btn ghost f', 'Zurück');
    b.style.alignSelf = 'flex-start';
    b.addEventListener('click', () => this.pop());
    col.append(b);
    body.append(col);
    return s;
  }

  // ================================================================= offline
  private startOffline(): void {
    this.audio.unlock();
    const profile = loadProfile(this.settings.name || 'Spieler', this.settings.appearance);
    const transport = new LoopbackTransport(this.world, profile, (p) => saveProfile(p));
    const params = new URLSearchParams(location.search);
    transport.lag = Number(params.get('lag') || 0) / 1000;
    transport.jitter = Number(params.get('jitter') || 0) / 1000;
    transport.loss = Number(params.get('loss') || 0) / 100;
    transport.room.traffic.density = this.settings.density;
    transport.room.peds.density = this.settings.density;
    const net = new NetClient(this.world, transport);
    this.dbg.room = transport.room;
    this.startGame(net);
  }
  private startGame(net: NetClient): void {
    this.setPreview(false);
    if (this.game) this.game.dispose();
    this.net = net;
    const game = new Game(this.engine, this.world, this.view, net, this.input);
    game.ui = this;
    game.audio = this.audio;
    this.game = game;
    this.hud.game = game;
    this.hud.waypoint = null;
    net.ev.other = (m) => this.onServer(m);
    this.dbg.game = game;
    this.dbg.net = net;
    this.stack.length = 0;
    this.show(null);
    this.hud.toast('Willkommen in Zürich. Drücke Esc bzw. die Menü-Taste für Karte und Aufträge.', 'info');
  }
  private quitToMenu(): void {
    if (this.net?.transport.kind === 'online') this.net.sendRaw({ t: 'leaveLobby' });
    this.game?.dispose();
    this.game = null;
    this.hud.game = null;
    this.hud.show(false);
    if (this.net?.transport.kind === 'online') {
      // keep the authenticated connection for the lobby browser
      this.stack.length = 0;
      this.show(this.onlineScreen());
    } else {
      this.net = null;
      this.stack.length = 0;
      this.show(this.mainMenu());
    }
  }

  // ================================================================= online
  private openOnline(): void {
    if (this.net && this.net.transport.kind === 'online' && this.account) { this.show(this.onlineScreen(), true); return; }
    if (!this.serverUrl) { this.show(this.serverScreen(), true); return; }
    this.show(this.connectingScreen('Verbinde mit dem Spielserver …'), true);
    this.connect();
  }
  private connect(): void {
    let url = this.serverUrl.trim();
    if (/^https?:/.test(url)) url = url.replace(/^http/, 'ws');
    if (!/^wss?:/.test(url)) url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + url;
    let transport: WsTransport;
    try {
      transport = new WsTransport(url, () => {
        if (this.settings.token) transport.send({ t: 'auth', mode: 'token', token: this.settings.token });
        else if (!this.reconnecting) this.replace(this.authScreen());
      });
    } catch {
      this.replace(this.serverScreen('Ungültige Serveradresse.'));
      return;
    }
    const net = new NetClient(this.world, transport);
    net.ev.other = (m) => this.onServer(m);
    net.ev.welcome = () => { this.reconnecting = false; this.lobbyCode = net.lobby?.code ?? ''; this.startGame(net); };
    net.ev.closed = (r) => this.closed(r);
    this.net = net;
    // the menu loop does not run net.update, so pump nothing here: WebSocket callbacks drive the pre-game flow
  }
  private replace(s: Screen): void {
    const cur = this.screen;
    if (cur) { cur.el.classList.remove('on'); setTimeout(() => cur.el.remove(), 300); }
    this.screen = null;
    this.show(s);
  }
  private onServer(m: ServerMsg): void {
    switch (m.t) {
      case 'auth':
        if (m.ok && m.account) {
          this.account = m.account;
          this.settings.token = m.token ?? this.settings.token;
          if (!this.settings.name) this.settings.name = m.account.name;
          saveSettings(this.settings);
          if (this.reconnecting && this.lobbyCode) this.net?.sendRaw({ t: 'joinLobby', code: this.lobbyCode });
          else if (!this.game) {
            this.replace(this.onlineScreen());
            if (this.lobbyCode) this.joinLobby({ code: this.lobbyCode });
          }
        } else {
          this.settings.token = '';
          saveSettings(this.settings);
          if (this.authMsg) this.authMsg(m.text ?? 'Anmeldung fehlgeschlagen.');
          else if (!this.game) this.replace(this.authScreen(m.text));
        }
        break;
      case 'lobbies': this.lobbies = m.list; this.refreshOnline?.(); break;
      case 'social':
        if (m.invites.length) {
          const inv = m.invites[0];
          this.hud.toast(`${inv.from} lädt dich in die Lobby ${inv.code} ein.`, 'good');
          this.pendingInvite = inv.code;
          this.refreshOnline?.();
        } else { this.friends = m.friends; this.requests = m.requests; this.refreshOnline?.(); }
        break;
      case 'error':
        if (m.code === 'nolobby' || m.code === 'full') { this.lobbyCode = ''; this.reconnecting = false; }
        this.hud.toast(m.text, 'bad');
        this.authMsg?.(m.text);
        if (this.screen?.el.id === 'connecting') this.replace(this.onlineScreen());
        break;
      case 'toast': this.hud.toast(m.text, m.kind ?? 'info'); break;
    }
  }
  private pendingInvite = '';
  private joinLobby(opts: { code?: string; create?: { private: boolean; name?: string }; quick?: boolean }): void {
    if (!this.net) return;
    this.audio.unlock();
    this.net.sendRaw({ t: 'joinLobby', ...opts, appearance: this.settings.appearance });
    this.show(this.connectingScreen('Lobby wird betreten …'), true);
  }
  private connectingScreen(text: string): Screen {
    const root = el('div', 'screen menu scrim');
    root.id = 'connecting';
    root.innerHTML = `<header><h1>${esc(text)}</h1></header><div class="body"><p class="caps" style="color:var(--dim)">${esc(this.serverUrl)}</p></div>`;
    const b = el('button', 'btn ghost f', 'Abbrechen');
    b.style.alignSelf = 'flex-start';
    b.addEventListener('click', () => { this.pop(); });
    root.append(b);
    return { el: root, back: () => this.pop() };
  }
  private serverScreen(err = ''): Screen {
    const { s, body } = this.menu('server', 'Spielserver', 'Online');
    const col = el('div', 'col wide panel');
    col.innerHTML = `<p>Trage die Adresse eures Spielservers ein (z. B. <b>wss://swiss-outlaws.onrender.com</b>). Die Deployment-Anleitung im Repository beschreibt, wie der Server in wenigen Minuten gestartet wird.</p>`;
    const f = el('div', 'field', `<label class="caps">Serveradresse</label>`);
    const inp = el('input', 'f');
    inp.type = 'text'; inp.value = this.serverUrl; inp.placeholder = 'wss://…';
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Enter') go(); });
    f.append(inp);
    const msg = el('div', 'err', esc(err));
    const go = () => {
      this.serverUrl = inp.value.trim();
      this.settings.serverUrl = this.serverUrl;
      saveSettings(this.settings);
      if (!this.serverUrl) { msg.textContent = 'Bitte eine Adresse eingeben.'; return; }
      this.pop();
      this.openOnline();
    };
    const b = el('button', 'btn f', 'Verbinden');
    b.addEventListener('click', go);
    const row = el('div', 'row');
    row.append(b);
    col.append(f, msg, row);
    body.append(col);
    return s;
  }
  private authScreen(err = ''): Screen {
    const { s, body } = this.menu('auth', 'Anmelden', 'Online');
    const col = el('div', 'col wide panel');
    const fName = el('div', 'field', `<label class="caps">Spielername</label>`), fPass = el('div', 'field', `<label class="caps">Passwort (mind. 6 Zeichen)</label>`);
    const name = el('input', 'f'), pass = el('input', 'f');
    name.type = 'text'; name.maxLength = 16; name.value = this.settings.name; name.autocomplete = 'username';
    pass.type = 'password'; pass.maxLength = 128; pass.autocomplete = 'current-password';
    for (const i of [name, pass]) i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Enter') send('login'); });
    fName.append(name); fPass.append(pass);
    const msg = el('div', 'err', esc(err));
    this.authMsg = (t) => { msg.textContent = t; };
    const send = (mode: 'login' | 'register' | 'guest') => {
      msg.textContent = '';
      this.net?.sendRaw({ t: 'auth', mode, name: name.value.trim(), password: pass.value });
    };
    const row = el('div', 'row');
    const mk = (label: string, mode: 'login' | 'register' | 'guest', ghost = false) => { const b = el('button', `btn f${ghost ? ' ghost' : ''}`, label); b.addEventListener('click', () => send(mode)); return b; };
    row.append(mk('Anmelden', 'login'), mk('Konto erstellen', 'register', true), mk('Als Gast spielen', 'guest', true));
    const note = el('p', '', 'Passwörter werden auf dem Server ausschliesslich als scrypt-Hash gespeichert. Gastkonten behalten ihren Fortschritt auf diesem Gerät.');
    note.style.marginTop = '18px';
    col.append(fName, fPass, msg, row, note);
    body.append(col);
    s.back = () => { this.authMsg = null; this.net?.transport.close(); this.net = null; this.stack.length = 0; this.show(this.mainMenu()); };
    return s;
  }
  private onlineScreen(): Screen {
    const { s, body, header } = this.menu('online', 'Online', this.account ? `Angemeldet als ${esc(this.account.name)}${this.account.guest ? ' (Gast)' : ''}` : '');
    void header;
    const list = el('div', 'col list');
    const right = el('div', 'col wide');
    const codeField = el('div', 'field', `<label class="caps">Lobby-Code</label>`);
    const code = el('input', 'f');
    code.type = 'text'; code.maxLength = 5; code.placeholder = 'ABCDE'; code.style.textTransform = 'uppercase'; code.style.letterSpacing = '.2em';
    code.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Enter' && code.value.trim().length === 5) this.joinLobby({ code: code.value.trim().toUpperCase() }); });
    codeField.append(code);
    list.append(
      this.item('01', 'Schnellspiel', () => this.joinLobby({ quick: true }), { right: 'Öffentlich', start: true }),
      this.item('02', 'Private Lobby erstellen', () => this.joinLobby({ create: { private: true } }), { right: 'Nur mit Code' }),
      this.item('03', 'Öffentliche Lobby erstellen', () => this.joinLobby({ create: { private: false } })),
      codeField,
      this.item('04', 'Mit Code beitreten', () => { if (code.value.trim().length === 5) this.joinLobby({ code: code.value.trim().toUpperCase() }); else code.focus(); }),
      this.item('05', 'Abmelden', () => { this.settings.token = ''; saveSettings(this.settings); this.account = null; this.net?.transport.close(); this.net = null; this.stack.length = 0; this.show(this.mainMenu()); }, { small: true }),
    );
    const render = () => {
      right.innerHTML = '';
      if (this.pendingInvite) {
        const inv = el('div', 'panel');
        inv.innerHTML = `<h2 class="caps">Einladung</h2><p>Du wurdest in die Lobby <b>${esc(this.pendingInvite)}</b> eingeladen.</p>`;
        const b = el('button', 'btn f', 'Beitreten');
        b.addEventListener('click', () => { const c = this.pendingInvite; this.pendingInvite = ''; this.joinLobby({ code: c }); });
        inv.append(b);
        right.append(inv);
      }
      const lob = el('div', 'panel');
      lob.innerHTML = `<h2 class="caps" style="margin-top:14px">Öffentliche Lobbys</h2>`;
      const pl = el('div', 'plist');
      if (!this.lobbies.length) pl.innerHTML = `<div class="p" style="color:var(--dim)">Keine offenen Lobbys – starte ein Schnellspiel.</div>`;
      for (const l of this.lobbies) {
        const row = el('div', 'p', `<span class="dot on"></span><b>${esc(l.name)}</b><span class="num">${l.players}/${l.max}</span><span class="sp"></span>`);
        const b = el('button', 'mini f', 'Beitreten');
        b.addEventListener('click', () => this.joinLobby({ code: l.code }));
        row.querySelector('.sp')!.append(b);
        pl.append(row);
      }
      lob.append(pl);
      right.append(lob, this.friendsPanel(false));
    };
    this.refreshOnline = render;
    render();
    body.append(list, right);
    s.onShow = () => { this.net?.sendRaw({ t: 'listLobbies' }); this.net?.sendRaw({ t: 'friend', op: 'list' }); };
    let t = 0;
    s.tick = (dt) => { t += dt; if (t > 4) { t = 0; this.net?.sendRaw({ t: 'listLobbies' }); } };
    s.back = () => { this.refreshOnline = null; this.stack.length = 0; this.show(this.mainMenu()); };
    return s;
  }
  private friendsPanel(inGame: boolean): HTMLElement {
    const box = el('div', 'panel');
    box.innerHTML = `<h2 class="caps" style="margin-top:18px">Freunde</h2>`;
    if (!this.account || !this.net || this.net.transport.kind !== 'online') {
      box.append(el('p', '', 'Die Freundesliste ist im Online-Modus verfügbar.'));
      return box;
    }
    const add = el('div', 'row');
    const inp = el('input', 'f');
    inp.type = 'text'; inp.maxLength = 16; inp.placeholder = 'Spielername';
    inp.style.cssText = 'background:transparent;border:0;border-bottom:1px solid var(--dim);padding:6px 0;outline:none;user-select:text;-webkit-user-select:text';
    const send = () => { if (inp.value.trim()) { this.net?.sendRaw({ t: 'friend', op: 'add', name: inp.value.trim() }); inp.value = ''; } };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Enter') send(); });
    const b = el('button', 'mini f', 'Anfrage senden');
    b.addEventListener('click', send);
    add.append(inp, b);
    box.append(add);
    const pl = el('div', 'plist');
    pl.style.marginTop = '10px';
    for (const r of this.requests) {
      const row = el('div', 'p', `<span class="dot"></span><b>${esc(r.name)}</b><span style="color:var(--dim)">möchte befreundet sein</span><span class="sp"></span>`);
      const y = el('button', 'mini f', 'Annehmen'), n = el('button', 'mini f', 'Ablehnen');
      y.addEventListener('click', () => this.net?.sendRaw({ t: 'friend', op: 'accept', id: r.id }));
      n.addEventListener('click', () => this.net?.sendRaw({ t: 'friend', op: 'decline', id: r.id }));
      row.querySelector('.sp')!.append(y, n);
      pl.append(row);
    }
    for (const f of this.friends) {
      const row = el('div', 'p', `<span class="dot${f.online ? ' on' : ''}"></span><b>${esc(f.name)}</b><span style="color:var(--dim)">${f.online ? (f.lobby ? `in Lobby ${esc(f.lobby)}` : 'online') : 'offline'}</span><span class="sp"></span>`);
      const sp = row.querySelector('.sp')!;
      if (inGame && f.online) { const i = el('button', 'mini f', 'Einladen'); i.addEventListener('click', () => this.net?.sendRaw({ t: 'friend', op: 'invite', id: f.id })); sp.append(i); }
      if (!inGame && f.lobby) { const j = el('button', 'mini f', 'Beitreten'); j.addEventListener('click', () => this.joinLobby({ code: f.lobby })); sp.append(j); }
      const x = el('button', 'mini f', 'Entfernen');
      x.addEventListener('click', () => this.net?.sendRaw({ t: 'friend', op: 'remove', id: f.id }));
      sp.append(x);
      pl.append(row);
    }
    if (!this.friends.length && !this.requests.length) pl.innerHTML = `<div class="p" style="color:var(--dim)">Noch keine Freunde – sende eine Anfrage über den Spielernamen.</div>`;
    box.append(pl);
    return box;
  }

  // ================================================================= in-game screens
  private openPause(tab = 0): void {
    if (!this.game || this.screen) return;
    this.paused = true;
    this.show(this.pauseScreen(tab));
  }
  private pauseScreen(start = 0): Screen {
    const online = this.net?.transport.kind === 'online';
    const { s, body, footer } = this.menu('pause', 'Pause', online ? `Lobby ${esc(this.lobbyCode)}` : 'Einzelspieler', 'scrim');
    footer.innerHTML = this.hints(['Q E|LB RB', 'Reiter'], ['↑↓|LS', 'Wählen'], ['Enter|A', 'OK'], ['Esc|B', 'Weiter']);
    const tabs = el('div', 'tabs');
    const content = el('div', 'col wide');
    const names = ['Spiel', 'Aufträge', 'Garage', 'Lobby', 'Statistik'];
    let cur = start;
    const draw = () => {
      [...tabs.children].forEach((c, i) => c.classList.toggle('on', i === cur));
      content.innerHTML = '';
      const net = this.net!, p = net.profile;
      if (cur === 0) {
        const list = el('div', 'col list');
        list.append(
          this.item('01', 'Weiterspielen', () => this.show(null), { start: true }),
          this.item('02', 'Karte', () => { this.show(null); this.openMap(); }),
          this.item('03', 'Charakter', () => this.show(this.characterInGame(), true)),
          this.item('04', 'Einstellungen', () => this.show(this.settingsScreen(true), true)),
          this.item('05', 'Steuerung', () => this.show(this.controlsScreen(true), true)),
          this.item('06', online ? 'Lobby verlassen' : 'Zum Hauptmenü', () => this.quitToMenu()),
        );
        content.append(list);
      } else if (cur === 1) {
        const m = net.mission;
        if (m) {
          const box = el('div', 'panel', `<h2 class="caps">Aktiver Auftrag</h2><p><b>${esc(m.title)}</b> – ${esc(m.text)}</p>`);
          const b = el('button', 'btn ghost f', 'Auftrag abbrechen');
          b.addEventListener('click', () => { net.command({ k: 'mission', op: 'abort' }); this.show(null); });
          box.append(b);
          content.append(box);
        }
        const list = el('div', 'col');
        ACTIVITIES.forEach((a, i) => {
          const done = p.missions.includes(a.id) ? ' · erledigt' : p.best[a.id] ? ` · Bestzeit ${p.best[a.id].toFixed(2)} s` : '';
          list.append(this.item(String(i + 1).padStart(2, '0'), a.title, () => { this.hud.waypoint = { x: a.x, z: a.z }; this.hud.toast(`Wegpunkt gesetzt: ${a.title}`, 'info'); this.show(null); }, { small: true, right: `${esc(a.desc)}${done}`, start: i === 0 && !m }));
        });
        content.append(el('h2', 'caps', 'Aktivitäten – Wegpunkt setzen'), list);
      } else if (cur === 2) {
        const owned = p.garage.map((id) => VEHICLES[id]).filter(Boolean);
        if (!owned.length) content.append(el('p', '', 'Du besitzt noch kein Fahrzeug. Die Garage Hürlimann in Zürich-West verkauft Fahrzeuge – setze unter «Aufträge» einen Wegpunkt.'));
        const list = el('div', 'col');
        owned.forEach((v, i) => list.append(this.item(String(i + 1).padStart(2, '0'), v.name, () => { net.command({ k: 'spawnOwned', spec: v.id }); this.show(null); }, { small: true, right: 'Liefern lassen · CHF 100', start: i === 0 })));
        const ammo = this.item('M', 'Munition kaufen (48 Schuss)', () => net.command({ k: 'buy', item: 'ammo' }), { small: true, right: 'CHF 120' });
        content.append(el('h2', 'caps', 'Eigene Fahrzeuge'), list, el('h2', 'caps', 'Ausrüstung'), ammo, el('p', '', `Pistole · ${net.ammo} Schuss · Goldvreneli ${p.secrets.length}/${SECRETS.length}`));
      } else if (cur === 3) {
        if (online) content.append(el('div', 'panel', `<h2 class="caps">Lobby-Code zum Teilen</h2><div class="code">${esc(this.lobbyCode)}</div><p style="margin-top:8px">Einladungslink: ${esc(location.origin + location.pathname)}?join=${esc(this.lobbyCode)}</p>`));
        const pl = el('div', 'plist');
        const myAcc = this.account?.id;
        for (const r of net.roster.values()) {
          const me = r.id === net.id;
          const row = el('div', 'p', `<span class="dot on"></span><b>${esc(r.name)}</b><span class="num" style="color:var(--dim)">Level ${r.level}</span>${me ? '<span style="color:var(--dim)">du</span>' : ''}<span class="sp"></span>`);
          if (!me && online) {
            const sp = row.querySelector('.sp')!;
            const blocked = this.hud.blocked.has(r.id);
            const bl = el('button', 'mini f', blocked ? 'Entblocken' : 'Blockieren');
            bl.addEventListener('click', () => { if (blocked) this.hud.blocked.delete(r.id); else this.hud.blocked.add(r.id); draw(); });
            const rep = el('button', 'mini f', 'Melden');
            rep.addEventListener('click', () => { net.sendRaw({ t: 'report', player: r.id, reason: 'Im Spiel gemeldet' }); });
            const fr = el('button', 'mini f', 'Freund +');
            fr.addEventListener('click', () => net.sendRaw({ t: 'friend', op: 'add', name: r.name }));
            if (r.account !== myAcc) sp.append(fr, bl, rep);
          }
          pl.append(row);
        }
        content.append(el('h2', 'caps', 'Spieler'), pl, this.friendsPanel(true));
        this.refreshOnline = () => { if (cur === 3) draw(); };
      } else {
        const st = p.stats;
        const dl = el('dl', 'kv');
        const rows: [string, string][] = [['Vermögen', `CHF ${chf(p.money)}`], ['Erfahrung', `${p.xp} XP`], ['Gefahrene Strecke', `${st.km.toFixed(1)} km`], ['Rennen', String(st.races)], ['Lieferungen', String(st.deliveries)], ['Verhaftet', String(st.busted)], ['Im Spital', String(st.wasted)], ['Goldvreneli', `${p.secrets.length}/${SECRETS.length}`], ['Spielzeit', `${Math.floor(st.playSeconds / 60)} min`]];
        dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
        content.append(dl);
      }
      const first = content.querySelector('.f.start') ?? content.querySelector('.f');
      if (first) this.focus(first as HTMLElement, false);
    };
    names.forEach((n, i) => { const b = el('button', '', n); b.addEventListener('click', () => { cur = i; draw(); }); tabs.append(b); });
    const col = el('div', 'col wide');
    col.append(tabs, content);
    body.append(col);
    s.onShow = draw;
    s.tab = (d) => { cur = (cur + d + names.length) % names.length; this.audio.ui('move'); draw(); };
    s.back = () => { this.refreshOnline = null; this.show(null); };
    return s;
  }
  private characterInGame(): Screen {
    const s = this.characterScreen();
    s.el.classList.remove('scrim-left');
    s.el.classList.add('scrim');
    s.onShow = undefined;
    s.back = () => this.pop();
    return s;
  }
  private dealerScreen(): Screen {
    const { s, body } = this.menu('dealer', 'Garage Hürlimann', 'Fahrzeughandel', 'scrim');
    const grid = el('div', 'cards');
    const net = this.net!;
    const draw = () => {
      grid.innerHTML = '';
      for (const v of VEHICLES.filter((x) => x.price > 0)) {
        const own = net.profile.garage.includes(v.id);
        const stat = (label: string, f: number) => `<div class="stat"><span class="caps">${label}</span><u style="width:${Math.round(Math.max(0.08, Math.min(1, f)) * 100)}%"></u></div>`;
        const c = el('button', 'card f', `<h3>${esc(v.name)}</h3><div class="caps">${{ compact: 'Kompaktwagen', sedan: 'Limousine', sport: 'Sportwagen', suv: 'Geländewagen', van: 'Lieferwagen', police: '', bus: '', truck: '' }[v.cls]} · ${['Front', 'Heck', 'Allrad'][v.drive]}antrieb</div><div class="price">${own ? '<span class="own">Im Besitz</span>' : `CHF ${chf(v.price)}`}</div>${stat('Leistung', v.powerKW / 345)}${stat('Grip', (v.grip - 0.85) / 0.45)}${stat('Bremsen', (v.brake - 8) / 4)}${stat('Gewicht', v.mass / 2300)}`);
        c.addEventListener('click', () => {
          if (own) { net.command({ k: 'spawnOwned', spec: v.id }); this.show(null); return; }
          if (net.money < v.price) { this.hud.toast('Zu wenig Geld.', 'bad'); this.audio.ui('fail'); return; }
          net.command({ k: 'buy', item: 'vehicle', id: v.id });
          this.show(null);
        });
        grid.append(c);
      }
    };
    draw();
    const col = el('div', 'col wide');
    col.append(el('p', '', `Kontostand: CHF ${chf(net.money)}. Gekaufte Fahrzeuge kannst du dir jederzeit über das Pausenmenü liefern lassen.`), grid);
    body.append(col);
    return s;
  }
  private openMap(): void {
    if (!this.game || this.screen) return;
    this.paused = true;
    const root = el('div', 'screen');
    root.id = 'bigmap';
    const canvas = el('canvas');
    const legend = el('div', 'legend shadow', `<h1>Karte</h1><div class="caps">Zürich und Umgebung</div><ul class="caps"><li style="--c:#ffd23a">Mission</li><li style="--c:#45b6ff">Rennen · Mitspieler</li><li style="--c:#5fd38d">Lieferdienst</li><li style="--c:#f3f1ea">Händler · Werkstatt</li><li style="--c:#ff5fd2">Wegpunkt</li></ul>`);
    const footer = el('footer', 'caps shadow', this.hints(['Ziehen|LS', 'Bewegen'], ['Mausrad|RT LT', 'Zoom'], ['Klick|A', 'Wegpunkt'], ['M Esc|B', 'Schliessen']));
    root.append(canvas, legend, footer);
    const h = this.game.hud;
    let cx = h.x, cz = h.z, scale = 0.5, drag = false, moved = false, cursor: { x: number; z: number } | null = null;
    const toWorld = (px: number, py: number) => ({ x: cx + (px - canvas.clientWidth / 2) / scale, z: cz + (py - canvas.clientHeight / 2) / scale });
    canvas.addEventListener('mousedown', () => { drag = true; moved = false; });
    window.addEventListener('mouseup', () => { drag = false; });
    canvas.addEventListener('mousemove', (e) => {
      if (drag) { cx -= e.movementX / scale; cz -= e.movementY / scale; if (Math.abs(e.movementX) + Math.abs(e.movementY) > 1) moved = true; }
      cursor = null;
    });
    canvas.addEventListener('click', (e) => { if (!moved) { const w = toWorld(e.offsetX, e.offsetY); this.setWaypoint(w.x, w.z); } });
    canvas.addEventListener('wheel', (e) => { scale = Math.max(0.2, Math.min(3, scale * (e.deltaY < 0 ? 1.15 : 0.87))); e.preventDefault(); }, { passive: false });
    const ctx = canvas.getContext('2d')!;
    const s: Screen = {
      el: root,
      back: () => this.show(null),
      key: (a) => {
        if (a === 'confirm') { const c = cursor ?? { x: cx, z: cz }; this.setWaypoint(c.x, c.z); return true; }
        if (a === 'up' || a === 'down' || a === 'left' || a === 'right') return true;
        return false;
      },
      tick: (dt) => {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth, hh = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
        // gamepad: left stick pans, triggers zoom
        const pad = (navigator.getGamepads?.() ?? []).find((g) => g);
        if (pad) {
          const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
          const ax = dz(pad.axes[0] ?? 0), ay = dz(pad.axes[1] ?? 0);
          if (ax || ay) { cx += (ax * 420 * dt) / scale; cz += (ay * 420 * dt) / scale; cursor = { x: cx, z: cz }; }
          const zi = (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
          if (zi) scale = Math.max(0.2, Math.min(3, scale * (1 + zi * dt * 1.4)));
        }
        const k = this.input;
        void k;
        cx = Math.max(-1536, Math.min(1536, cx)); cz = Math.max(-1536, Math.min(1536, cz));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.hud.overlay.secrets = this.net?.profile.secrets ?? [];
        this.mapView.drawBig(ctx, w, hh, cx, cz, scale, this.hud.overlay, cursor);
      },
    };
    this.show(s);
  }
  private setWaypoint(x: number, z: number): void {
    const cur = this.hud.waypoint;
    if (cur && Math.hypot(cur.x - x, cur.z - z) < 30) { this.hud.waypoint = null; this.hud.toast('Wegpunkt entfernt', 'info'); }
    else { this.hud.waypoint = { x, z }; this.audio.ui('select'); }
  }

  // ================================================================= GameUi
  frame(s: HudState): void {
    this.hud.frame(s, 1 / Math.max(20, s.fps));
  }
  toast(text: string, kind: string): void {
    this.hud.toast(text, kind);
  }
  chat(name: string, text: string, sys: boolean, from: number): void {
    this.hud.chat(name, text, sys, from);
  }
  mission(m: MissionView | null, result?: { ok: boolean; title: string; reward: number; xp: number; detail?: string }): void {
    this.hud.missionResult(m, result);
  }
  wasted(busted: boolean, fee: number): void {
    this.hud.wasted(busted, fee);
    this.audio.ui('fail');
  }
  roster(): void {
    this.refreshOnline?.();
  }
  profile(_p: Profile): void {
    this.refreshOnline?.();
  }
  closed(reason: string): void {
    if (!this.net || this.net.transport.kind !== 'online') return;
    if (this.game && this.lobbyCode && this.settings.token) {
      // automatic reconnect: the server keeps the avatar for 90 s
      this.reconnecting = true;
      let tries = 0;
      const attempt = () => {
        if (!this.reconnecting) return;
        if (++tries > 12) { this.reconnecting = false; this.game?.dispose(); this.game = null; this.hud.show(false); this.net = null; this.stack.length = 0; this.show(this.mainMenu()); this.hud.toast('Verbindung zum Server verloren.', 'bad'); return; }
        this.hud.toast(`Verbindung unterbrochen – Wiederverbinden (${tries}) …`, 'bad');
        this.connect();
        setTimeout(() => { if (this.reconnecting) attempt(); }, 2500);
      };
      attempt();
    } else if (!this.game) {
      this.account = null;
      this.net = null;
      this.stack.length = 0;
      this.show(this.serverScreen(`Server nicht erreichbar (${reason}).`));
    }
  }
}
const _focus = new THREE.Vector3(), _zero = new THREE.Vector3(-60, 10, 40);
const PREVIEW_ANIM = { speed: 0, moveX: 0, moveZ: 1, grounded: true, crouch: false, swim: false, aim: false, aimPitch: 0, vy: 0, mode: 0, melee: 0, fired: false, armed: false, sprint: false };
export type { Appearance };
