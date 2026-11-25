// Unified input: keyboard + mouse (pointer lock) and gamepad (Xbox layout) mapped to game actions.
import { clamp } from '../../shared/math';

export interface InputSettings {
  mouseSens: number; // radians per pixel at 1.0
  padSens: number; // stick look speed multiplier
  deadzone: number;
  invertY: boolean;
  vibration: boolean;
}
export const defaultInputSettings: InputSettings = { mouseSens: 1, padSens: 1, deadzone: 0.16, invertY: false, vibration: true };

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause' | 'tabL' | 'tabR' | 'map';

export class Input {
  settings: InputSettings = { ...defaultInputSettings };
  // --- analogue state (updated by poll)
  moveX = 0; // right +
  moveY = 0; // forward +
  lookX = 0; // yaw delta this frame (radians, + = turn right)
  lookY = 0; // pitch delta this frame (radians, + = look up)
  throttle = 0;
  steer = 0;
  // --- held buttons
  jump = false; sprint = false; crouch = false; aim = false; fire = false; handbrake = false; horn = false; walk = false;
  // --- edge-triggered (true for one frame)
  usePressed = false; meleePressed = false; lightsPressed = false; sirenPressed = false; camPressed = false; mapPressed = false; pausePressed = false; chatPressed = false; weaponPressed = false; jumpPressed = false;
  /** last used device, drives the on-screen prompts */
  device: 'kbm' | 'pad' = 'kbm';
  /** when true the game ignores gameplay input (menus, chat) */
  uiMode = true;
  locked = false;
  onMenu: ((a: MenuAction) => void) | null = null;
  padConnected = false;

  private keys = new Set<string>();
  private pressed = new Set<string>();
  private mdx = 0; private mdy = 0;
  private mouseL = false; private mouseR = false; private mousePressedL = false;
  private crouchToggle = false;
  private prevPad: boolean[] = [];
  private repeat = { dir: '', t: 0 };
  private canvas: HTMLElement;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.code === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.device = 'kbm';
      if (this.uiMode && this.onMenu) {
        const m: Record<string, MenuAction> = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Enter: 'confirm', Space: 'confirm', Escape: 'back', Backspace: 'back', KeyQ: 'tabL', KeyE: 'tabR', KeyM: 'map' };
        const a = m[e.code];
        if (a) { this.onMenu(a); e.preventDefault(); }
      }
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseL = this.mouseR = false; });
    canvas.addEventListener('mousedown', (e) => {
      this.device = 'kbm';
      if (e.button === 0) { this.mouseL = true; this.mousePressedL = true; }
      if (e.button === 2) this.mouseR = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseL = false;
      if (e.button === 2) this.mouseR = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (this.locked) { this.mdx += e.movementX; this.mdy += e.movementY; }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    window.addEventListener('gamepadconnected', () => { this.padConnected = true; });
    window.addEventListener('gamepaddisconnected', () => { this.padConnected = (navigator.getGamepads?.() ?? []).some((g) => g); });
  }

  /** Drop pending key presses (called when menus open/close so one key press never triggers two things). */
  flush(): void {
    this.pressed.clear();
    this.mousePressedL = false;
    this.mdx = this.mdy = 0;
    const pad = (navigator.getGamepads?.() ?? []).find((g) => g);
    if (pad) this.prevPad = pad.buttons.map((x) => x.pressed);
  }

  requestLock(): void {
    if (!this.locked && this.canvas.requestPointerLock) {
      try { (this.canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* not allowed without gesture */ }
    }
  }
  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private dz(v: number): number {
    const d = this.settings.deadzone;
    const a = Math.abs(v);
    return a < d ? 0 : (Math.sign(v) * (a - d)) / (1 - d);
  }

  rumble(strong: number, weak: number, ms: number): void {
    if (!this.settings.vibration || this.device !== 'pad') return;
    const pad = (navigator.getGamepads?.() ?? []).find((g) => g);
    const act = (pad as unknown as { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } })?.vibrationActuator;
    act?.playEffect('dual-rumble', { duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch(() => {});
  }

  /** Read devices; call once per frame before the game logic. */
  poll(dt: number): void {
    const k = this.keys, p = this.pressed;
    const s = this.settings;
    let mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let my = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let lookX = this.mdx * 0.0023 * s.mouseSens, lookY = -this.mdy * 0.0023 * s.mouseSens * (s.invertY ? -1 : 1);
    this.mdx = this.mdy = 0;
    let throttle = my, steer = mx;
    let jump = k.has('Space'), sprint = k.has('ShiftLeft') || k.has('ShiftRight'), aim = this.mouseR, fire = this.mouseL, handbrake = k.has('Space'), horn = k.has('KeyH');
    let walk = k.has('AltLeft');
    let use = p.has('KeyE') || p.has('KeyF'), melee = p.has('KeyQ') || (this.mousePressedL && !this.mouseR), lights = p.has('KeyL'), siren = p.has('KeyG'), cam = p.has('KeyV'), map = p.has('KeyM'), pause = p.has('Escape') || p.has('KeyP'), chat = p.has('KeyT') || p.has('Enter'), weapon = p.has('Digit1') || p.has('Digit2') || p.has('KeyX');
    let jumpPressed = p.has('Space');
    if (p.has('KeyC') || p.has('ControlLeft')) this.crouchToggle = !this.crouchToggle;
    this.mousePressedL = false;
    p.clear();

    // ---- gamepad (standard mapping)
    const pad = (navigator.getGamepads?.() ?? []).find((g) => g && g.connected && g.mapping === 'standard') ?? (navigator.getGamepads?.() ?? []).find((g) => g && g.connected);
    if (pad) {
      this.padConnected = true;
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const bv = (i: number) => pad.buttons[i]?.value ?? 0;
      const edge = (i: number) => b(i) && !this.prevPad[i];
      const lx = this.dz(pad.axes[0] ?? 0), ly = this.dz(pad.axes[1] ?? 0), rx = this.dz(pad.axes[2] ?? 0), ry = this.dz(pad.axes[3] ?? 0);
      const any = Math.abs(lx) + Math.abs(ly) + Math.abs(rx) + Math.abs(ry) > 0.05 || pad.buttons.some((x) => x.pressed);
      if (any) this.device = 'pad';
      if (this.device === 'pad') {
        mx = lx; my = -ly;
        // response curve: fine control near the centre
        const curve = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1.7);
        lookX += curve(rx) * 2.9 * s.padSens * dt;
        lookY += -curve(ry) * 2.0 * s.padSens * dt * (s.invertY ? -1 : 1);
        throttle = bv(7) - bv(6);
        steer = lx;
        // Xbox layout – on foot: A sprint, X jump, B punch, Y enter/exit, LT aim, RT fire, d-pad down crouch
        // in a vehicle: RT gas, LT brake/reverse, A or RB handbrake, L3 horn, d-pad right lights, d-pad left siren
        jump = jump || b(2); jumpPressed = jumpPressed || edge(2);
        sprint = sprint || b(0);
        aim = aim || bv(6) > 0.4;
        fire = fire || bv(7) > 0.5;
        handbrake = handbrake || b(0) || b(5);
        horn = horn || b(10);
        use = use || edge(3);
        melee = melee || edge(1);
        lights = lights || edge(15);
        siren = siren || edge(14);
        cam = cam || edge(11);
        map = map || edge(8);
        pause = pause || edge(9);
        weapon = weapon || edge(12);
        if (edge(13)) this.crouchToggle = !this.crouchToggle;
        // menu navigation with repeat
        if (this.uiMode && this.onMenu) {
          const dir = ly < -0.5 || b(12) ? 'up' : ly > 0.5 || b(13) ? 'down' : lx < -0.5 || b(14) ? 'left' : lx > 0.5 || b(15) ? 'right' : '';
          if (dir !== this.repeat.dir) { this.repeat.dir = dir; this.repeat.t = 0.38; if (dir) this.onMenu(dir as MenuAction); }
          else if (dir) { this.repeat.t -= dt; if (this.repeat.t <= 0) { this.repeat.t = 0.13; this.onMenu(dir as MenuAction); } }
          if (edge(0)) this.onMenu('confirm');
          if (edge(1)) this.onMenu('back');
          if (edge(9)) this.onMenu('pause');
          if (edge(4)) this.onMenu('tabL');
          if (edge(5)) this.onMenu('tabR');
          if (edge(8)) this.onMenu('map');
        }
      }
      this.prevPad = pad.buttons.map((x) => x.pressed);
    }
    const ui = this.uiMode;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    this.moveX = ui ? 0 : mx; this.moveY = ui ? 0 : my;
    this.lookX = ui ? 0 : lookX; this.lookY = ui ? 0 : lookY;
    this.throttle = ui ? 0 : clamp(throttle, -1, 1); this.steer = ui ? 0 : clamp(steer, -1, 1);
    this.jump = !ui && jump; this.sprint = !ui && sprint; this.aim = !ui && aim; this.fire = !ui && fire; this.handbrake = !ui && handbrake; this.horn = !ui && horn; this.walk = !ui && walk;
    this.crouch = !ui && this.crouchToggle;
    this.usePressed = !ui && use; this.meleePressed = !ui && melee; this.lightsPressed = !ui && lights; this.sirenPressed = !ui && siren; this.camPressed = !ui && cam; this.weaponPressed = !ui && weapon; this.jumpPressed = !ui && jumpPressed;
    this.mapPressed = map; this.pausePressed = pause; this.chatPressed = !ui && chat;
    if (this.sprint || this.jump) this.crouchToggle = false;
  }
}
