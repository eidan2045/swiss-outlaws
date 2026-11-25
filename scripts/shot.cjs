// Dev helper: open the game in headless Chromium, run a snippet, save a screenshot.
// usage: node scripts/shot.mjs <out.png> "<url query>" "<js to eval before shot>" [waitMs] [width] [height]
const { chromium } = require('playwright');
(async () => {
const [out, query = '', js = '', waitMs = '2500', width = '1280', height = '720'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: +width, height: +height }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
await page.goto(`http://localhost:${process.env.PORT || 5173}/?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__dbg && window.__dbg.frames > 2, null, { timeout: 120000 });
if (js) await page.evaluate(js);
await page.waitForTimeout(+waitMs);
await page.screenshot({ path: out, timeout: 180000 });
const info = await page.evaluate(() => { const d = window.__dbg; const i = d.engine.renderer.info; return { fps: Math.round(d.fps), calls: i.render.calls, tris: i.render.triangles, frames: d.frames, extra: window.__shotInfo ? window.__shotInfo() : undefined }; });
console.log(JSON.stringify(info));
if (logs.length) console.log(logs.slice(0, 25).join('\n'));
await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
