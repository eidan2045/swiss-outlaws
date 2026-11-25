// Measures load time, draw calls, triangles, frame time and memory per graphics profile (headless Chromium).
// NOTE: without a GPU this runs on SwiftShader (software rasteriser) – frame times are NOT representative of real hardware.
const { chromium } = require('playwright');
const fs = require('node:fs');
(async () => {
  const url = process.argv[2] || 'http://localhost:5173/';
  const out = { date: new Date().toISOString(), renderer: '', profiles: [] };
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const q of ['low', 'medium', 'high', 'ultra']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const t0 = Date.now();
    await page.goto(`${url}?q=${q}&play=1`);
    await page.waitForFunction(() => window.__dbg && window.__dbg.net && window.__dbg.net.ready, null, { timeout: 180000 });
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(q === 'low' ? 6000 : 12000);
    const r = await page.evaluate(async () => {
      const d = window.__dbg, gl = d.engine.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const f0 = d.frames, t0 = performance.now();
      await new Promise((res) => setTimeout(res, 6000));
      const frames = d.frames - f0, ms = performance.now() - t0;
      const i = d.engine.renderer.info;
      return { gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown', frameMs: +(ms / Math.max(1, frames)).toFixed(1), calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1, worldGenMs: d.world.genMs, pixelRatio: d.engine.renderer.getPixelRatio() };
    });
    out.renderer = r.gpu;
    out.profiles.push({ profile: q, loadMs, ...r });
    console.log(q, JSON.stringify({ loadMs, ...r }));
    await page.close();
  }
  await browser.close();
  fs.mkdirSync('docs/test-results', { recursive: true });
  fs.writeFileSync('docs/test-results/performance.json', JSON.stringify(out, null, 2));
})();
