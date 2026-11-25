// Browser E2E for sandbox aim assist/ESP, character customisation sync, friends (search by ID, accept, join, invite)
// and auto-rejoin after a page reload (online and offline). Writes docs/test-results/e2e-features.json.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8792;
const results = { date: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, url, name) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__dbg && window.__dbg.frames > 2, null, { timeout: 120000 });
  return page;
}
const ready = (p) => p.waitForFunction(() => window.__dbg.net && window.__dbg.net.ready && window.__dbg.game, null, { timeout: 40000 });
const st = (p) => p.evaluate(() => {
  const d = window.__dbg, n = d.net, g = d.game;
  return { id: n.id, code: n.lobby && n.lobby.code, sandbox: !!(n.lobby && n.lobby.sandbox), x: n.rx, z: n.rz, hp: n.char.hp, ammo: n.ammo, players: [...n.players.keys()], aimbot: g.assistCfg.aimbot, esp: g.assistCfg.esp, target: g.assist.target, account: d.app.account && d.app.account.id, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) };
});
async function guestOnline(p) {
  await p.keyboard.press('Enter');
  await p.getByText('Online spielen').click();
  await p.getByText('Als Gast spielen').click();
  await p.waitForSelector('#online', { timeout: 20000 });
}
async function pause(p, tab) {
  await p.evaluate(() => window.__dbg.app.openPause());
  await p.waitForSelector('#pause.on');
  if (tab) await p.locator('#pause .tabs button', { hasText: tab }).click();
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-feat-'));
  const server = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STATIC_DIR: path.resolve('dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300 && !log.includes('listening'); i++) await sleep(100);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const base = `http://127.0.0.1:${PORT}/?q=low&norender=1`;
  try {
    // ---------------------------------------------------------------- sandbox lobby
    const A = await open(browser, base, 'A');
    await guestOnline(A);
    await A.getByText('Private Sandbox-Lobby').click();
    await ready(A);
    const a0 = await st(A);
    check('A creates a private sandbox lobby', a0.sandbox && /^[A-Z0-9]{5}$/.test(a0.code), { code: a0.code, sandbox: a0.sandbox });
    const B = await open(browser, `${base}&join=${a0.code}`, 'B');
    await B.getByText('Als Gast spielen').click();
    await ready(B);
    await sleep(1500);
    const b0 = await st(B);
    check('B joins the sandbox lobby via invitation link', b0.code === a0.code && b0.players.length === 1);

    // aimbot toggle with Y + strength + auto fire
    await A.evaluate(() => { const c = window.__dbg.game.assistCfg; c.strength = 5; c.autoFire = true; c.tPolice = false; c.tPeds = false; });
    await A.keyboard.press('KeyY');
    await A.keyboard.press('KeyU');
    await sleep(400);
    const a1 = await st(A);
    check('Y toggles the aimbot, U toggles ESP (sandbox)', a1.aimbot && a1.esp, { aimbot: a1.aimbot, esp: a1.esp });
    // turn A's camera roughly towards B so B is inside the strength-5 cone, then let the assist do the rest
    await A.evaluate((bid) => { const d = window.__dbg, r = d.net.players.get(bid); d.game.cam.yaw = Math.atan2(r.x - d.net.rx, r.z - d.net.rz) + 0.5; d.game.cam.pitch = 0; }, b0.id);
    await sleep(1500);
    const a2 = await st(A);
    check('aimbot locks onto the other player', a2.target && a2.target.kind === 'player' && a2.target.id === b0.id, a2.target);
    const yawErr = await A.evaluate((bid) => { const d = window.__dbg, r = d.net.players.get(bid); const want = Math.atan2(r.x - d.engine.camera.position.x, r.z - d.engine.camera.position.z); let e = d.game.cam.yaw - want; while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI; return Math.abs(e); }, b0.id);
    check('camera is turned onto the target (< 3°)', yawErr < 0.052, { yawErrDeg: +(yawErr * 57.3).toFixed(2) });
    await sleep(2000);
    const b1 = await st(B), a3 = await st(A);
    check('auto fire shoots and the server applies the hits', a3.ammo < a1.ammo && b1.hp < 100, { ammoUsed: (await st(A)).ammo - a1.ammo, hpB: Math.round(b1.hp) });
    const outlined = await A.evaluate((bid) => { const m = window.__dbg.game.chars.get(bid); return !!m && m.outlined; }, b0.id);
    check('ESP draws a through-wall outline on the other player', outlined);
    await A.evaluate(() => { window.__dbg.game.assistCfg.autoFire = false; window.__dbg.game.assistCfg.aimbot = false; });

    // ---------------------------------------------------------------- public lobby: no assist
    const C = await open(browser, base, 'C');
    await guestOnline(C);
    await C.getByText('Schnellspiel', { exact: true }).click();
    await ready(C);
    await C.keyboard.press('KeyY');
    await C.keyboard.press('KeyU');
    await sleep(500);
    const c0 = await st(C);
    check('aimbot and ESP stay off in a public lobby', !c0.aimbot && !c0.esp && !c0.sandbox && c0.toasts.some((t) => t.includes('nur im Einzelspieler')), { aimbot: c0.aimbot, esp: c0.esp });

    // ---------------------------------------------------------------- character customisation
    await pause(A);
    await A.locator('#pause .item', { hasText: 'Charakter' }).click();
    await A.waitForSelector('#char.on');
    await A.locator('#char .tabs button', { hasText: 'Oberteil' }).click();
    await A.locator('#char .chips button', { hasText: 'Hoodie' }).click();
    await A.locator('#char .tabs button', { hasText: 'Accessoires' }).click();
    await A.locator('#char .chips button', { hasText: 'Rucksack' }).click();
    await A.locator('#char .tabs button', { hasText: 'Haare & Kopf' }).click();
    await A.locator('#char .chips button', { hasText: 'Mütze' }).click();
    await sleep(1200);
    const lookOnB = await B.evaluate((aid) => { const d = window.__dbg; const info = d.net.roster.get(aid); return { look: info && info.look, model: d.game.looks.get(aid) }; }, a0.id);
    const decoded = await B.evaluate((look) => { const R = [['skin', 5], ['hair', 6], ['hairStyle', 7], ['jacket', 16], ['pants', 8], ['shoes', 4], ['build', 3], ['hat', 4], ['top', 5], ['legs', 3], ['feet', 3], ['acc', 5]]; const a = {}; for (const [k, n] of R) { a[k] = look % n; look = Math.floor(look / n); } return a; }, lookOnB.look);
    check('outfit change is visible to the other player', decoded.top === 1 && decoded.acc === 3 && decoded.hat === 2 && lookOnB.model === lookOnB.look, decoded);
    await A.keyboard.press('Escape');
    await sleep(300);
    await A.keyboard.press('Escape');

    // ---------------------------------------------------------------- friends: search by ID, request, accept
    await pause(B, 'Lobby');
    const aId = a0.account;
    await B.locator('#pause input[placeholder="Name oder #ID"]').fill('#' + aId);
    await B.locator('#pause button.mini', { hasText: 'Suchen' }).click();
    await B.locator('#pause button.mini', { hasText: 'Anfrage senden' }).first().click({ timeout: 10000 });
    await pause(A, 'Lobby').catch(() => {});
    await A.locator('#pause button.mini', { hasText: 'Annehmen' }).click({ timeout: 10000 });
    await sleep(800);
    const fb = await B.evaluate(() => window.__dbg.app.friends.map((f) => ({ name: f.name, online: f.online, lobby: f.lobby })));
    check('friend request via unique ID is accepted, online status + lobby shown', fb.length === 1 && fb[0].online && fb[0].lobby === a0.code, fb);
    await A.keyboard.press('Escape');
    await B.keyboard.press('Escape');

    // C (public lobby) befriends A, then uses the Join button to switch into A's world
    const cAcc = c0.account;
    await C.evaluate((aid) => window.__dbg.net.sendRaw({ t: 'friend', op: 'add', id: aid }), aId);
    await A.waitForFunction(() => window.__dbg.app.requests.length > 0, null, { timeout: 10000 });
    await A.evaluate(() => window.__dbg.net.sendRaw({ t: 'friend', op: 'accept', id: window.__dbg.app.requests[0].id }));
    await pause(C, 'Lobby');
    await C.waitForFunction(() => window.__dbg.app.friends.some((f) => f.lobby), null, { timeout: 10000 });
    await C.evaluate(() => window.__dbg.app.refreshOnline && window.__dbg.app.refreshOnline());
    await C.locator('#pause button.mini', { hasText: 'Beitreten' }).first().click();
    await C.waitForFunction((code) => window.__dbg.net.lobby && window.__dbg.net.lobby.code === code && window.__dbg.net.ready, a0.code, { timeout: 20000 });
    await sleep(1000);
    const c1 = await st(C);
    check('Join button moves C into the friend\'s world', c1.code === a0.code && c1.players.length === 2, { code: c1.code, players: c1.players.length });

    // invitation from inside the game
    const D = await open(browser, base, 'D');
    await guestOnline(D);
    await D.getByText('Schnellspiel', { exact: true }).click();
    await ready(D);
    const dAcc = (await st(D)).account;
    await D.evaluate((aid) => window.__dbg.net.sendRaw({ t: 'friend', op: 'add', id: aid }), aId);
    await A.waitForFunction(() => window.__dbg.app.requests.length > 0, null, { timeout: 10000 });
    await A.evaluate(() => window.__dbg.net.sendRaw({ t: 'friend', op: 'accept', id: window.__dbg.app.requests[0].id }));
    await sleep(600);
    await pause(A, 'Lobby');
    await A.locator('#pause .p', { hasText: 'Gast' }).locator('button', { hasText: 'Einladen' }).first().click();
    await D.waitForFunction(() => window.__dbg.app.pendingInvite, null, { timeout: 10000 });
    await pause(D, 'Lobby');
    await D.locator('#pause button.mini', { hasText: 'Beitreten' }).first().click();
    await D.waitForFunction((code) => window.__dbg.net.lobby && window.__dbg.net.lobby.code === code && window.__dbg.net.ready, a0.code, { timeout: 20000 });
    check('in-game invitation brings D into A\'s world', (await st(D)).code === a0.code);
    void cAcc; void dAcc;

    // ---------------------------------------------------------------- auto-rejoin after reload (online)
    await A.keyboard.press('Escape');
    const bPos = await st(B);
    await B.reload();
    await B.waitForFunction(() => window.__dbg && window.__dbg.net && window.__dbg.net.ready && window.__dbg.game, null, { timeout: 60000 });
    await sleep(1200);
    const b2 = await st(B);
    check('reload: B rejoins the same world automatically with the same avatar', b2.code === a0.code && b2.id === b0.id, { code: b2.code, id: b2.id });
    check('reload: B keeps its position', Math.hypot(b2.x - bPos.x, b2.z - bPos.z) < 2, { metres: +Math.hypot(b2.x - bPos.x, b2.z - bPos.z).toFixed(2) });
    const bApp = await B.evaluate(() => window.__dbg.app.settings.appearance);
    void bApp;

    // tab closed for good (context closed) → after the grace period the profile position is used
    // (covered by tests/integration/persistence.test.ts with a full server restart)

    // ---------------------------------------------------------------- offline resume
    const O = await open(browser, `http://127.0.0.1:${PORT}/?q=low&norender=1&play=1`, 'O');
    await ready(O);
    await O.keyboard.down('KeyW');
    await sleep(2500);
    await O.keyboard.up('KeyW');
    await sleep(300);
    const o1 = await st(O);
    await O.goto(`http://127.0.0.1:${PORT}/?q=low&norender=1`);
    await O.waitForFunction(() => window.__dbg && window.__dbg.net && window.__dbg.net.ready && window.__dbg.game, null, { timeout: 60000 });
    await sleep(800);
    const o2 = await st(O);
    check('offline: reopening the page resumes single player at the saved position', Math.hypot(o2.x - o1.x, o2.z - o1.z) < 2.5, { metres: +Math.hypot(o2.x - o1.x, o2.z - o1.z).toFixed(2) });
  } catch (e) {
    check('test run completed without exception', false, String(e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
  results.passed = results.checks.filter((c) => c.ok).length;
  results.failed = results.checks.filter((c) => !c.ok).length;
  fs.mkdirSync('docs/test-results', { recursive: true });
  fs.writeFileSync('docs/test-results/e2e-features.json', JSON.stringify(results, null, 2));
  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed ? 1 : 0);
})();
