// Procedural audio (Web Audio API, no samples): positional engines, tyres, horns, sirens, ambience by zone and
// weather, footsteps per surface, gunshots, crashes, tunnel reverb and a generative music bed.
import type { AudioState, AudioVehicle, GameAudio } from '../game';
import { Surf } from '../../shared/world/world';
import { Zone } from '../../shared/world/layout';
import { VEHICLES } from '../../shared/sim/types';

interface EngineVoice {
  id: number;
  osc: OscillatorNode[];
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: PannerNode;
  horn: GainNode;
  hornOsc: OscillatorNode[];
  siren: GainNode;
  sirenOsc: OscillatorNode;
  used: boolean;
}

export class AudioSystem implements GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private musicBus!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private noise!: AudioBuffer;
  private voices: EngineVoice[] = [];
  private loops: Record<string, { gain: GainNode; filter: BiquadFilterNode }> = {};
  private vol = { master: 0.8, music: 0.5, sfx: 0.9 };
  private birdT = 2;
  private musicT = 0;
  private musicStep = 0;
  private musicOn = false;
  private cam = { x: 0, y: 0, z: 0 };
  private lastFlash = 0;
  private inVehicle = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    // tunnel reverb: decaying noise impulse
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 2.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6) * (i < 600 ? i / 600 : 1);
    }
    conv.buffer = ir;
    this.sfx.connect(this.dry).connect(this.master);
    this.sfx.connect(this.wet).connect(conv).connect(this.master);
    this.musicBus.connect(this.master);
    // shared noise
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    // continuous beds
    const loop = (name: string, type: BiquadFilterType, freq: number, q = 0.7) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.sfx);
      src.start();
      this.loops[name] = { gain, filter };
    };
    loop('city', 'lowpass', 220);
    loop('wind', 'bandpass', 520, 0.5);
    loop('rain', 'highpass', 2600);
    loop('water', 'lowpass', 700);
    loop('skid', 'bandpass', 1150, 2.2);
    loop('rush', 'lowpass', 900);
    this.setVolumes(this.vol.master, this.vol.music, this.vol.sfx);
  }

  setVolumes(master: number, music: number, sfx: number): void {
    this.vol = { master, music, sfx };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(master, t, 0.05);
    this.musicBus.gain.setTargetAtTime(music * 0.5, t, 0.2);
    this.sfx.gain.setTargetAtTime(sfx, t, 0.05);
  }
  music(on: boolean): void {
    this.musicOn = on;
  }

  // ---------------------------------------------------------------- helpers
  private panner(x: number, y: number, z: number, ref = 5): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1.5;
    p.maxDistance = 400;
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    return p;
  }
  private burst(dur: number, type: BiquadFilterType, freq: number, vol: number, dest: AudioNode, q = 0.8, sweepTo = 0): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(ctx.currentTime, Math.random());
    src.stop(ctx.currentTime + dur + 0.05);
  }
  private tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', dest: AudioNode = this.sfx, delay = 0, slideTo = 0): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    const t0 = ctx.currentTime + delay;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  // ---------------------------------------------------------------- one-shots
  shot(x: number, y: number, z: number, own: boolean): void {
    if (!this.ctx) return;
    const p = this.panner(x, y, z, own ? 30 : 9);
    p.connect(this.sfx);
    this.burst(0.16, 'bandpass', 1900, own ? 0.75 : 1.1, p, 0.6, 500);
    this.burst(0.3, 'lowpass', 420, own ? 0.9 : 1.2, p, 0.7, 80);
  }
  crash(x: number, y: number, z: number, amount: number): void {
    if (!this.ctx) return;
    const p = this.panner(x, y, z, 7);
    p.connect(this.sfx);
    this.burst(0.25 + amount * 0.3, 'lowpass', 900 + amount * 900, 0.5 + amount * 0.9, p, 0.6, 150);
    for (const f of [310, 523, 870, 1320]) this.burst(0.2 + amount * 0.25, 'bandpass', f * (0.9 + Math.random() * 0.2), 0.35 * amount + 0.1, p, 14);
  }
  explode(x: number, y: number, z: number): void {
    if (!this.ctx) return;
    const p = this.panner(x, y, z, 26);
    p.connect(this.sfx);
    this.burst(2.2, 'lowpass', 520, 2.4, p, 0.5, 40);
    this.burst(0.5, 'bandpass', 1500, 1.2, p, 0.5, 300);
  }
  step(_left: boolean, surface: number, run: boolean, wet: boolean): void {
    if (!this.ctx) return;
    const v = (run ? 0.2 : 0.11) * (this.inVehicle ? 0 : 1);
    if (v <= 0) return;
    switch (surface) {
      case Surf.Grass: case Surf.Field: case Surf.Forest: this.burst(0.11, 'lowpass', 600, v * 0.9, this.sfx, 0.5); break;
      case Surf.Gravel: case Surf.Rock: this.burst(0.13, 'highpass', 1700, v * 0.8, this.sfx, 0.5); this.burst(0.05, 'bandpass', 700, v, this.sfx, 1); break;
      case Surf.Snow: this.burst(0.16, 'bandpass', 1400, v * 0.6, this.sfx, 0.4, 600); break;
      case Surf.Sand: this.burst(0.12, 'lowpass', 900, v * 0.7, this.sfx, 0.4); break;
      default: this.burst(0.055, 'bandpass', wet ? 1500 : 950, v * 1.15, this.sfx, 1.4); this.burst(0.04, 'lowpass', 260, v, this.sfx, 0.7);
    }
    if (wet) this.burst(0.09, 'highpass', 3000, v * 0.5, this.sfx, 0.5);
  }
  ui(kind: 'cash' | 'fail' | 'ok' | 'star' | 'shift' | 'jump' | 'land' | 'punch' | 'prop' | 'move' | 'select' | 'back'): void {
    if (!this.ctx) return;
    switch (kind) {
      case 'cash': this.tone(1318, 0.09, 0.16, 'square'); this.tone(1760, 0.22, 0.16, 'square', this.sfx, 0.08); break;
      case 'fail': this.tone(220, 0.35, 0.22, 'sawtooth', this.sfx, 0, 110); break;
      case 'ok': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.5, 0.13, 'triangle', this.sfx, i * 0.09)); break;
      case 'star': this.tone(880, 0.12, 0.2, 'square'); this.tone(660, 0.2, 0.2, 'square', this.sfx, 0.13); break;
      case 'shift': this.burst(0.04, 'bandpass', 1800, 0.12, this.sfx, 3); break;
      case 'jump': this.burst(0.08, 'lowpass', 500, 0.12, this.sfx); break;
      case 'land': this.burst(0.12, 'lowpass', 240, 0.4, this.sfx); break;
      case 'punch': this.burst(0.09, 'lowpass', 320, 0.7, this.sfx); this.burst(0.05, 'bandpass', 1900, 0.3, this.sfx, 1); break;
      case 'prop': for (const f of [620, 1480, 2330]) this.burst(0.35, 'bandpass', f, 0.35, this.sfx, 18); break;
      case 'move': this.tone(660, 0.04, 0.05, 'square'); break;
      case 'select': this.tone(880, 0.06, 0.08, 'square'); this.tone(1320, 0.09, 0.07, 'square', this.sfx, 0.05); break;
      case 'back': this.tone(520, 0.07, 0.07, 'square', this.sfx, 0, 330); break;
    }
  }

  // ---------------------------------------------------------------- engines
  private newVoice(): EngineVoice {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = this.panner(0, 0, 0, 5);
    const osc: OscillatorNode[] = [];
    for (const [type, mix] of [['sawtooth', 0.5], ['square', 0.28], ['sawtooth', 0.34]] as [OscillatorType, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = mix;
      o.connect(g).connect(filter);
      o.start();
      osc.push(o);
    }
    filter.connect(gain).connect(pan).connect(this.sfx);
    const horn = ctx.createGain();
    horn.gain.value = 0;
    const hornOsc = [420, 528].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(horn);
      o.start();
      return o;
    });
    const hf = ctx.createBiquadFilter();
    hf.type = 'lowpass';
    hf.frequency.value = 2400;
    horn.connect(hf).connect(pan);
    const siren = ctx.createGain();
    siren.gain.value = 0;
    const sirenOsc = ctx.createOscillator();
    sirenOsc.type = 'sawtooth';
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 900;
    sf.Q.value = 0.8;
    sirenOsc.connect(sf).connect(siren).connect(pan);
    sirenOsc.start();
    return { id: -1, osc, filter, gain, pan, horn, hornOsc, siren, sirenOsc, used: false };
  }

  frame(s: AudioState): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    this.inVehicle = s.inVehicle;
    // listener
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.value = s.cam.x; L.positionY.value = s.cam.y; L.positionZ.value = s.cam.z;
      L.forwardX.value = s.forward.x; L.forwardY.value = s.forward.y; L.forwardZ.value = s.forward.z;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      (L as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(s.cam.x, s.cam.y, s.cam.z);
      (L as unknown as { setOrientation: (...a: number[]) => void }).setOrientation(s.forward.x, s.forward.y, s.forward.z, 0, 1, 0);
    }
    this.cam.x = s.cam.x; this.cam.y = s.cam.y; this.cam.z = s.cam.z;

    // ---- vehicle voices: the own car first, then the nearest ones
    const list = s.vehicles.filter((v) => v.engine || v.horn || v.siren).sort((a, b) => (a.own ? -1 : b.own ? 1 : this.d2(a) - this.d2(b))).slice(0, 7);
    for (const v of this.voices) v.used = false;
    let own: AudioVehicle | null = null;
    for (const v of list) {
      if (v.own) own = v;
      let voice = this.voices.find((x) => x.id === v.id) ?? this.voices.find((x) => !x.used && !list.some((l) => l.id === x.id));
      if (!voice) {
        if (this.voices.length >= 7) continue;
        voice = this.newVoice();
        this.voices.push(voice);
      }
      voice.id = v.id;
      voice.used = true;
      const spec = VEHICLES[v.spec] ?? VEHICLES[0];
      const base = spec.cls === 'bus' ? 26 : spec.cls === 'van' || spec.cls === 'suv' ? 34 : spec.cls === 'sport' ? 52 : 42;
      const f = base * (0.9 + v.rpm * (spec.cls === 'sport' ? 3.9 : 3.1));
      voice.osc[0].frequency.setTargetAtTime(f, t, 0.03);
      voice.osc[1].frequency.setTargetAtTime(f * 0.5, t, 0.03);
      voice.osc[2].frequency.setTargetAtTime(f * 1.503, t, 0.03);
      voice.filter.frequency.setTargetAtTime(260 + v.rpm * 1500 + v.throttle * 1700, t, 0.05);
      const g = v.engine ? (v.own ? 0.16 + v.throttle * 0.2 : 0.3 + v.throttle * 0.25) * (0.55 + v.rpm * 0.6) : 0;
      voice.gain.gain.setTargetAtTime(g, t, 0.06);
      voice.pan.positionX.setTargetAtTime(v.x, t, 0.04); voice.pan.positionY.setTargetAtTime(v.y, t, 0.04); voice.pan.positionZ.setTargetAtTime(v.z, t, 0.04);
      voice.horn.gain.setTargetAtTime(v.horn ? 0.22 : 0, t, 0.015);
      voice.siren.gain.setTargetAtTime(v.siren ? 0.5 : 0, t, 0.05);
      // Swiss two-tone horn (cis–gis)
      if (v.siren) voice.sirenOsc.frequency.setTargetAtTime(Math.floor(t / 0.72) % 2 ? 554 : 415, t, 0.01);
    }
    for (const v of this.voices) if (!v.used) { v.gain.gain.setTargetAtTime(0, t, 0.08); v.horn.gain.setTargetAtTime(0, t, 0.02); v.siren.gain.setTargetAtTime(0, t, 0.05); v.id = -1; }

    // ---- beds
    const set = (name: string, g: number, f?: number) => {
      const l = this.loops[name];
      l.gain.gain.setTargetAtTime(g, t, 0.25);
      if (f) l.filter.frequency.setTargetAtTime(f, t, 0.25);
    };
    const urban = s.zone === Zone.OldTown || s.zone === Zone.Downtown || s.zone === Zone.Business || s.zone === Zone.Station || s.zone === Zone.Industrial ? 1 : s.zone === Zone.Residential ? 0.5 : s.zone === Zone.Hillside || s.zone === Zone.Village ? 0.2 : 0.04;
    const day = 1 - s.night * 0.65;
    set('city', urban * day * 0.3 * (s.inVehicle ? 0.5 : 1), 180 + urban * 120);
    const alpine = s.zone === Zone.Alpine ? 1 : s.zone === Zone.Forest ? 0.35 : 0.12;
    set('wind', (0.03 + s.wind * 0.16) * (0.4 + alpine) * (s.inVehicle ? 0.4 : 1) + (s.cam.y > 120 ? 0.05 : 0), 380 + s.wind * 500);
    set('rain', s.rain * (s.inVehicle ? 0.2 : 0.3), s.inVehicle ? 900 : 2600);
    set('water', s.swim ? 0.35 : s.cam.y < 9 && s.zone === Zone.Park ? 0.05 : 0, s.swim ? 500 : 800);
    set('skid', own ? Math.min(0.5, own.slip * 0.55) * (own.speed > 3 ? 1 : 0) : 0, 950 + (own ? own.speed * 9 : 0));
    set('rush', s.inVehicle ? Math.min(0.42, s.speed * 0.008) : 0, 500 + s.speed * 22);
    this.wet.gain.setTargetAtTime(s.tunnel ? 0.75 : 0, t, 0.3);

    // ---- wildlife
    const dtApprox = 1 / 60;
    this.birdT -= dtApprox;
    if (this.birdT <= 0) {
      const nature = s.zone === Zone.Forest || s.zone === Zone.Park || s.zone === Zone.Hillside || s.zone === Zone.Rural || s.zone === Zone.Village || s.zone === Zone.Alpine;
      if (nature && s.rain < 0.3 && !s.inVehicle) {
        if (s.night < 0.4) {
          // bird phrase
          const f0 = 2200 + Math.random() * 2400, n = 2 + Math.floor(Math.random() * 4);
          const p = this.panner(s.cam.x + (Math.random() - 0.5) * 60, s.cam.y + 8, s.cam.z + (Math.random() - 0.5) * 60, 14);
          p.connect(this.sfx);
          for (let i = 0; i < n; i++) this.tone(f0 * (1 + Math.random() * 0.25), 0.09, 0.07, 'sine', p, i * 0.13, f0 * (0.75 + Math.random() * 0.6));
          this.birdT = 0.8 + Math.random() * 3.2;
        } else {
          // crickets
          for (let i = 0; i < 5; i++) this.tone(4300, 0.03, 0.02, 'sine', this.sfx, i * 0.055);
          this.birdT = 0.6 + Math.random() * 1.6;
        }
      } else if (urban > 0.5 && !s.inVehicle && Math.random() < 0.3) {
        // distant city life: a faraway horn
        const p = this.panner(s.cam.x + (Math.random() - 0.5) * 300, s.cam.y, s.cam.z + (Math.random() - 0.5) * 300, 30);
        p.connect(this.sfx);
        this.tone(440, 0.35, 0.3, 'square', p);
        this.birdT = 5 + Math.random() * 10;
      } else this.birdT = 2;
    }

    // ---- music bed
    this.updateMusic(t, s.inVehicle, s.wanted);
  }
  thunder(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastFlash < 2) return;
    this.lastFlash = now;
    this.burst(3.2, 'lowpass', 300, 1.6, this.sfx, 0.5, 50);
  }
  /** Menu / idle update when no game is running. */
  idle(): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) { v.gain.gain.setTargetAtTime(0, t, 0.1); v.horn.gain.setTargetAtTime(0, t, 0.02); v.siren.gain.setTargetAtTime(0, t, 0.05); }
    for (const k of Object.keys(this.loops)) this.loops[k].gain.gain.setTargetAtTime(k === 'wind' ? 0.05 : 0, t, 0.4);
    this.updateMusic(t, false, 0);
  }
  private d2(v: AudioVehicle): number {
    return (v.x - this.cam.x) ** 2 + (v.z - this.cam.z) ** 2;
  }

  // ---------------------------------------------------------------- generative music
  private updateMusic(t: number, driving: boolean, wanted: number): void {
    if (!this.musicOn || this.vol.music <= 0.01) return;
    if (this.musicT === 0) this.musicT = t + 0.2;
    // schedule a little ahead
    while (this.musicT < t + 0.4) {
      const step = this.musicStep++;
      const tempo = wanted > 0 ? 0.21 : driving ? 0.27 : 0.36;
      const prog = [[57, 60, 64, 67], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]]; // Am7 Fmaj7 C G
      const bar = Math.floor(step / 16) % 4;
      const chord = prog[bar];
      const when = this.musicT - t;
      const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
      if (step % 16 === 0) {
        // pad
        for (const n of chord) for (const det of [-4, 5]) this.pad(hz(n - 12) * Math.pow(2, det / 1200), tempo * 16, 0.035, when);
        this.pad(hz(chord[0] - 24), tempo * 16, 0.06, when);
      }
      // arpeggio pluck
      const pat = [0, 2, 1, 3, 2, 1, 3, 2];
      if (step % 2 === 0 && (driving || wanted > 0 || step % 4 === 0)) {
        const n = chord[pat[(step / 2) % 8]] + (step % 32 < 16 ? 12 : 24);
        this.tone(hz(n), tempo * 3, 0.045, 'triangle', this.musicBus, when);
      }
      // pulse when driving / wanted
      if ((driving || wanted > 0) && step % 4 === 0) this.burstAt(when, 0.07, 'lowpass', 150, 0.5);
      if (wanted > 0 && step % 4 === 2) this.burstAt(when, 0.03, 'highpass', 5000, 0.12);
      this.musicT += tempo;
    }
  }
  private pad(freq: number, dur: number, vol: number, delay: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500;
    f.frequency.linearRampToValueAtTime(1200, ctx.currentTime + delay + dur * 0.5);
    f.frequency.linearRampToValueAtTime(450, ctx.currentTime + delay + dur);
    const g = ctx.createGain();
    const t0 = ctx.currentTime + delay;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + dur * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur * 1.1);
    o.connect(f).connect(g).connect(this.musicBus);
    o.start(t0);
    o.stop(t0 + dur * 1.15);
  }
  private burstAt(delay: number, dur: number, type: BiquadFilterType, freq: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t0 = ctx.currentTime + delay;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    src.connect(f).connect(g).connect(this.musicBus);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }
}
