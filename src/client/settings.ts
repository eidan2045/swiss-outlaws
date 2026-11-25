// Persistent client settings and the offline profile (localStorage; everything degrades gracefully without storage).
import { Appearance, Profile, defaultAppearance, newProfile, sanitizeAppearance } from '../shared/net/protocol';
import type { QualityName } from './render/globals';
import { AssistSettings, defaultAssist } from './assist';

export interface Settings {
  quality: QualityName | 'auto';
  resScale: number;
  master: number;
  music: number;
  sfx: number;
  mouseSens: number;
  padSens: number;
  deadzone: number;
  invertY: boolean;
  vibration: boolean;
  showFps: boolean;
  serverUrl: string;
  name: string;
  token: string;
  appearance: Appearance;
  blocked: string[];
  density: number;
  assist: AssistSettings;
  outfits: Appearance[];
  /** the world to rejoin after a reload / restart (cleared when leaving via the menu) */
  lastSession: { mode: 'offline' | 'online'; server: string; code: string; at: number } | null;
}
/** settings that follow the account to other devices */
export const SYNCED_KEYS = ['quality', 'resScale', 'master', 'music', 'sfx', 'mouseSens', 'padSens', 'deadzone', 'invertY', 'vibration', 'showFps'] as const;
const KEY = 'swiss-outlaws.settings.v1', PKEY = 'swiss-outlaws.profile.v1';

function store(): Storage | null {
  try {
    const s = window.localStorage;
    s.getItem(KEY);
    return s;
  } catch {
    return null;
  }
}
export function loadSettings(): Settings {
  const def: Settings = { quality: 'auto', resScale: 1, master: 0.8, music: 0.5, sfx: 0.9, mouseSens: 1, padSens: 1, deadzone: 0.16, invertY: false, vibration: true, showFps: false, serverUrl: '', name: '', token: '', appearance: defaultAppearance(Math.floor(Math.random() * 1e6)), blocked: [], density: 1, assist: { ...defaultAssist }, outfits: [], lastSession: null };
  try {
    const raw = store()?.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      Object.assign(def, saved);
      def.assist = { ...defaultAssist, ...(saved.assist ?? {}) };
      def.appearance = sanitizeAppearance(def.appearance);
    }
  } catch { /* corrupt → defaults */ }
  return def;
}
export function saveSettings(s: Settings): void {
  try { store()?.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
export function loadProfile(name: string, appearance: Appearance): Profile {
  try {
    const raw = store()?.getItem(PKEY);
    if (raw) {
      const p = { ...newProfile(name), ...(JSON.parse(raw) as Profile) };
      p.name = name || p.name;
      p.appearance = appearance;
      return p;
    }
  } catch { /* ignore */ }
  const p = newProfile(name || 'Spieler');
  p.appearance = appearance;
  return p;
}
export function saveProfile(p: Profile): void {
  try { store()?.setItem(PKEY, JSON.stringify(p)); } catch { /* ignore */ }
}
