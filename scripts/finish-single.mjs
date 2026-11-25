// Copies the self-contained build to standalone/index.html (the file that can be opened directly from disk).
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('dist-single/index.html');
const outDir = path.resolve('standalone');
fs.mkdirSync(outDir, { recursive: true });
let html = fs.readFileSync(src, 'utf8');
// classic inline script instead of a module script: works from file:// in every browser
if (/<script type="module" crossorigin>/.test(html)) html = html.replace('<script type="module" crossorigin>', '<script type="module">');
fs.writeFileSync(path.join(outDir, 'index.html'), html);
const kb = (fs.statSync(path.join(outDir, 'index.html')).size / 1024).toFixed(0);
const external = [...html.matchAll(/(?:src|href)="(https?:[^"]+|\/[^"]+)"/g)].map((m) => m[1]);
console.log(`standalone/index.html written (${kb} KB). External references: ${external.length ? external.join(', ') : 'none'}`);
