// Account store: scrypt password hashes, hashed session tokens, friends, persistent profiles (JSON file, atomic writes).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Profile, newProfile } from '../shared/net/protocol';

export interface Account {
  id: string;
  name: string;
  guest: boolean;
  salt: string;
  hash: string;
  tokens: string[]; // sha256 of issued tokens
  created: number;
  lastSeen: number;
  profile: Profile;
  friends: string[];
  requests: string[]; // incoming friend requests (account ids)
  blocked: string[];
}

const NAME_RE = /^[A-Za-z0-9_\-äöüÄÖÜ]{3,16}$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class Store {
  private accounts = new Map<string, Account>();
  private byName = new Map<string, string>();
  private byToken = new Map<string, string>();
  private dirty = false;
  private file: string;
  reports: { at: number; by: string; target: string; reason: string }[] = [];

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'accounts.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { accounts: Account[] };
      for (const a of raw.accounts) this.index(a);
    } catch { /* first start */ }
    setInterval(() => this.flush(), 5000).unref();
  }
  private index(a: Account): void {
    this.accounts.set(a.id, a);
    this.byName.set(a.name.toLowerCase(), a.id);
    for (const t of a.tokens) this.byToken.set(t, a.id);
  }
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ accounts: [...this.accounts.values()] }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] write failed', e);
      this.dirty = true;
    }
  }
  touch(): void {
    this.dirty = true;
  }
  get(id: string): Account | undefined {
    return this.accounts.get(id);
  }
  findByName(name: string): Account | undefined {
    const id = this.byName.get(name.toLowerCase());
    return id ? this.accounts.get(id) : undefined;
  }
  private issueToken(a: Account): string {
    const token = randomBytes(32).toString('hex');
    const h = sha(token);
    a.tokens.push(h);
    if (a.tokens.length > 5) this.byToken.delete(a.tokens.shift()!);
    this.byToken.set(h, a.id);
    this.dirty = true;
    return token;
  }
  private create(name: string, guest: boolean, password?: string): Account {
    const salt = randomBytes(16).toString('hex');
    const a: Account = {
      id: randomBytes(9).toString('base64url'), name, guest, salt, hash: password ? scryptSync(password, salt, 64).toString('hex') : '',
      tokens: [], created: Date.now(), lastSeen: Date.now(), profile: newProfile(name, Math.floor(Math.random() * 1e6)), friends: [], requests: [], blocked: [],
    };
    this.index(a);
    this.dirty = true;
    return a;
  }

  register(name: string, password: string): { ok: true; account: Account; token: string } | { ok: false; text: string } {
    if (!NAME_RE.test(name)) return { ok: false, text: 'Name: 3–16 Zeichen (Buchstaben, Ziffern, _ und -).' };
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) return { ok: false, text: 'Passwort: mindestens 6 Zeichen.' };
    if (this.byName.has(name.toLowerCase())) return { ok: false, text: 'Dieser Name ist bereits vergeben.' };
    const a = this.create(name, false, password);
    return { ok: true, account: a, token: this.issueToken(a) };
  }
  login(name: string, password: string): { ok: true; account: Account; token: string } | { ok: false; text: string } {
    const a = this.findByName(String(name));
    // constant-time comparison; identical error for unknown name and wrong password
    const salt = a?.salt ?? '00';
    const got = scryptSync(String(password), salt, 64);
    const want = a && a.hash ? Buffer.from(a.hash, 'hex') : Buffer.alloc(64);
    if (!a || a.guest || !a.hash || !timingSafeEqual(got, want)) return { ok: false, text: 'Name oder Passwort falsch.' };
    a.lastSeen = Date.now();
    return { ok: true, account: a, token: this.issueToken(a) };
  }
  guest(name?: string): { ok: true; account: Account; token: string } {
    let n = name && NAME_RE.test(name) && !this.byName.has(name.toLowerCase()) ? name : '';
    while (!n || this.byName.has(n.toLowerCase())) n = 'Gast-' + Math.floor(1000 + Math.random() * 9000);
    const a = this.create(n, true);
    return { ok: true, account: a, token: this.issueToken(a) };
  }
  byTokenValue(token: string): Account | undefined {
    if (typeof token !== 'string' || token.length !== 64) return undefined;
    const id = this.byToken.get(sha(token));
    const a = id ? this.accounts.get(id) : undefined;
    if (a) a.lastSeen = Date.now();
    return a;
  }
}
