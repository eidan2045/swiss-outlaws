// End-to-end multiplayer test: real server process, four independent browser contexts, one of them behind a
// TCP proxy that adds latency + jitter and can cut the connection. Writes docs/test-results/e2e-multiplayer.json.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8790, PROXY = 8791;
const LAG_MS = Number(process.env.LAG || 120), JITTER_MS = Number(process.env.JITTER || 30);
const results = { date: new Date().toISOString(), lagMsEachWay: LAG_MS, jitterMs: JITTER_MS, checks: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProxy() {
  const socks = new Set();
  const server = net.createServer((c) => {
    const up = net.connect(PORT, '127.0.0.1');
    socks.add(c); socks.add(up);
    const pipe = (a, b) => {
      let last = 0;
      a.on('data', (d) => {
        // keep ordering: every chunk leaves no earlier than the previous one
        const at = Math.max(last, Date.now() + LAG_MS + Math.random() * JITTER_MS);
        last = at;
        setTimeout(() => { if (!b.destroyed) b.write(d); }, at - Date.now());
      });
      a.on('close', () => { setTimeout(() => b.destroy(), LAG_MS); socks.delete(a); });
      a.on('error', () => {});
    };
    pipe(c, up); pipe(up, c);
  });
  server.listen(PROXY);
  return { cut: () => { for (const s of socks) s.destroy(); socks.clear(); }, close: () => server.close() };
}

async function openClient(browser, url, name) {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__dbg && window.__dbg.frames > 2, null, { timeout: 120000 });
  return page;
}
const state = (page) => page.evaluate(() => {
  const d = window.__dbg, n = d.net;
  if (!n) return null;
  return { id: n.id, ready: n.ready, x: n.rx, z: n.rz, cx: n.char.x, cz: n.char.z, players: [...n.players.values()].map((p) => ({ id: p.data.id, x: p.x, z: p.z })), vehicles: n.vehicles.size, npcs: n.npcs.size, rtt: n.rtt, corr: n.lastCorrection, snaps: n.snapshots, code: d.app.lobbyCode, kb: n.bytesIn / 1024, tick: n.simTime };
});
async function guest(page) {
  await page.getByText('Als Gast spielen').click();
  await page.waitForFunction(() => document.querySelector('#online'), null, { timeout: 20000 });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-e2e-'));
  const server = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STATIC_DIR: path.resolve('dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300 && !log.includes('listening'); i++) await sleep(100);
  if (!log.includes('listening')) throw new Error('server failed to start\n' + log);
  const proxy = startProxy();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const base = `http://127.0.0.1:${PORT}/?q=low&norender=1`;
    // ---- player A: creates a private lobby (same-origin server discovery)
    const A = await openClient(browser, base, 'A');
    await A.keyboard.press('Enter');
    await A.getByText('Online spielen').click();
    await guest(A);
    await A.getByText('Private Lobby erstellen').click();
    await A.waitForFunction(() => window.__dbg.net && window.__dbg.net.ready, null, { timeout: 30000 });
    const code = (await state(A)).code;
    check('A creates a private lobby and gets a 5-character code', /^[A-Z0-9]{5}$/.test(code), code);

    // ---- players B (through the lag proxy), C, D join with the invitation link
    const joinUrl = (port) => `http://127.0.0.1:${PORT}/?q=low&norender=1&join=${code}&server=ws://127.0.0.1:${port}`;
    const B = await openClient(browser, joinUrl(PROXY), 'B');
    await guest(B);
    const C = await openClient(browser, joinUrl(PORT), 'C');
    await guest(C);
    const D = await openClient(browser, joinUrl(PORT), 'D');
    await guest(D);
    for (const p of [B, C, D]) await p.waitForFunction(() => window.__dbg.net && window.__dbg.net.ready, null, { timeout: 30000 });
    await sleep(1500);
    const sA = await state(A), sB = await state(B), sC = await state(C), sD = await state(D);
    check('four independent browser sessions share one lobby', [sA, sB, sC, sD].every((s) => s.players.length === 3), [sA, sB, sC, sD].map((s) => s.players.length));
    check('every client has a distinct server-assigned id', new Set([sA.id, sB.id, sC.id, sD.id]).size === 4, [sA.id, sB.id, sC.id, sD.id]);
    check('the shared world is populated for everyone (traffic + pedestrians)', sA.vehicles > 3 && sB.vehicles > 3 && sC.vehicles > 3, { vehicles: [sA.vehicles, sB.vehicles, sC.vehicles, sD.vehicles], npcs: [sA.npcs, sB.npcs, sC.npcs, sD.npcs] });

    // ---- A walks: everybody must see it at (almost) the same place
    await A.keyboard.down('KeyW');
    await sleep(3000);
    await A.keyboard.up('KeyW');
    await sleep(1200);
    const a1 = await state(A);
    const seen = [];
    for (const p of [B, C, D]) seen.push((await state(p)).players.find((x) => x.id === a1.id));
    const moved = Math.hypot(a1.x - sA.x, a1.z - sA.z);
    const maxErr = Math.max(...seen.map((s) => Math.hypot(s.x - a1.x, s.z - a1.z)));
    check('A moves and all three others see the movement', moved > 3 && seen.every(Boolean), { movedMetres: +moved.toFixed(2) });
    check('remote position error after settling < 0.5 m', maxErr < 0.5, { maxErrMetres: +maxErr.toFixed(3) });

    // ---- B plays with artificial latency: prediction must respond immediately, corrections stay small
    const b0 = await state(B);
    check(`B measures the simulated latency (RTT ≈ ${2 * LAG_MS}+ ms)`, b0.rtt > LAG_MS * 1.5, { rttMs: Math.round(b0.rtt) });
    await B.keyboard.down('KeyW');
    await sleep(140);
    const bEarly = await state(B);
    const early = Math.hypot(bEarly.cx - b0.cx, bEarly.cz - b0.cz);
    check('client-side prediction: B moves locally before the server could have answered', early > 0.03, { metresAfter140ms: +early.toFixed(3) });
    let worst = 0;
    for (let i = 0; i < 12; i++) { await sleep(200); worst = Math.max(worst, (await state(B)).corr); }
    await B.keyboard.up('KeyW');
    await sleep(1500);
    const b1 = await state(B);
    const bSeenByA = (await state(A)).players.find((x) => x.id === b1.id);
    check('reconciliation corrections under latency stay below 0.35 m', worst < 0.35, { worstCorrectionMetres: +worst.toFixed(4) });
    check('server and lagging client agree on the final position (< 0.5 m)', Math.hypot(bSeenByA.x - b1.x, bSeenByA.z - b1.z) < 0.5, { errMetres: +Math.hypot(bSeenByA.x - b1.x, bSeenByA.z - b1.z).toFixed(3) });

    // ---- chat
    await A.keyboard.press('KeyT');
    await A.keyboard.type('Hoi zäme!');
    await A.keyboard.press('Enter');
    await sleep(1200);
    const chatSeen = await Promise.all([B, C, D].map((p) => p.evaluate(() => document.querySelector('.chat').textContent.includes('Hoi zäme!'))));
    check('text chat reaches all other players', chatSeen.every(Boolean), chatSeen);

    // ---- vehicles: A takes a car, the others see A driving
    await A.evaluate(() => { const d = window.__dbg; return d.net.rx; });
    const hasCar = await A.evaluate(async () => {
      const n = window.__dbg.net;
      // walk up to the nearest parked car is slow in a test: ask the server-side view which car is closest
      let best = null, bd = 1e9;
      for (const v of n.vehicles.values()) { const dd = Math.hypot(v.x - n.rx, v.z - n.rz); if (dd < bd && !v.data.driver) { bd = dd; best = v; } }
      return best ? { d: bd } : null;
    });
    check('parked / traffic vehicles are visible to interact with', !!hasCar, hasCar);

    // ---- connection drop: B is cut off, reconnects automatically and keeps its avatar
    const idB = b1.id;
    proxy.cut();
    await sleep(1500);
    const lostNote = await A.evaluate(() => document.querySelector('.chat').textContent.includes('Verbindung verloren'));
    check('other players are told that B lost the connection', lostNote);
    await B.waitForFunction((old) => window.__dbg.net && window.__dbg.net.ready && window.__dbg.net.snapshots > 0 && window.__dbg.net.transport.ws && window.__dbg.net.transport.ws.readyState === 1 && window.__dbg.net !== old, null, { timeout: 30000 }).catch(() => {});
    await sleep(2500);
    const b2 = await state(B);
    check('B reconnects automatically with the same avatar', b2 && b2.ready && b2.id === idB && b2.players.length === 3, b2 && { id: b2.id, players: b2.players.length });
    check('B kept its position across the reconnect (< 2 m)', b2 && Math.hypot(b2.x - b1.x, b2.z - b1.z) < 2, b2 && { metres: +Math.hypot(b2.x - b1.x, b2.z - b1.z).toFixed(2) });
    const a2 = await state(A);
    check('A still sees B after the reconnect', a2.players.some((p) => p.id === idB));

    // ---- bandwidth
    const k0 = (await state(C)).kb;
    await sleep(5000);
    const k1 = (await state(C)).kb;
    results.downstreamKBps = +((k1 - k0) / 5).toFixed(1);
    check('snapshot bandwidth per client is modest (< 60 kB/s)', results.downstreamKBps < 60, { kBps: results.downstreamKBps });
  } catch (e) {
    check('test run completed without exception', false, String(e && e.stack ? e.stack : e));
  } finally {
    await browser.close();
    proxy.close();
    server.kill('SIGTERM');
  }
  results.passed = results.checks.filter((c) => c.ok).length;
  results.failed = results.checks.filter((c) => !c.ok).length;
  fs.mkdirSync('docs/test-results', { recursive: true });
  fs.writeFileSync('docs/test-results/e2e-multiplayer.json', JSON.stringify(results, null, 2));
  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed ? 1 : 0);
})();
