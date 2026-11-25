import { App } from './app';

const app = new App();
app.boot().catch((e) => {
  console.error(e);
  const ui = document.getElementById('ui');
  if (ui) ui.innerHTML = `<div style="position:fixed;inset:0;display:grid;place-items:center;padding:24px;font:16px/1.5 system-ui;color:#f3f1ea;background:#0b0c0e;text-align:center;pointer-events:auto"><div><h1 style="font-weight:900;letter-spacing:-.03em">Swiss Outlaws konnte nicht starten</h1><p>Dieser Browser unterstützt WebGL 2 nicht oder es ist ein Fehler aufgetreten.</p><pre style="white-space:pre-wrap;opacity:.7">${String(e && (e as Error).message ? (e as Error).message : e)}</pre></div></div>`;
});
