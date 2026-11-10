// Renders assets/concepts/sheet.png: every concept at 512 (scaled preview), 64, 32 and 16 px,
// plus a 5x pixel zoom of the true 16 px raster, on light, dark and ember backgrounds.
// Usage: node packages/brand/scripts/concept-sheet.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRAND_DIR, EMBER_BG, GRAIN_CSS, forDark, openRenderer } from './lib/browser.mjs';

const dir = resolve(BRAND_DIR, 'assets/concepts');
const files = readdirSync(dir).filter((f) => /^concept-\d+\.svg$/.test(f)).sort();
const concepts = files.map((f) => {
  const svg = readFileSync(resolve(dir, f), 'utf8');
  const title = /<!--\s*(Concept[^:]*):?\s*(.*?)\s*-->/s.exec(svg);
  return { file: f, svg, name: title?.[1] ?? f, idea: title?.[2] ?? '' };
});

const uri = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
const bgs = [
  { key: 'light', css: 'background:#FAFAF9;', fg: '#161615', dark: false },
  { key: 'dark', css: 'background:#0C0C0B;', fg: '#EDECE8', dark: true },
  { key: 'ember', css: EMBER_BG, fg: '#EDECE8', dark: true },
];

const W = 1600;
const ROW = 224;
const H = 64 + ROW * concepts.length + 16;

const rows = concepts
  .map((c, i) => {
    const panels = bgs
      .map((b) => {
        const src = uri(b.dark ? forDark(c.svg) : c.svg);
        return `<div class="panel" style="${b.css}"><div class="grain"></div>
          <img src="${src}" width="140" height="140">
          <div class="small">
            <img src="${src}" width="64" height="64">
            <img src="${src}" width="32" height="32">
            <img src="${src}" width="16" height="16">
            <canvas class="zoom" data-src="${src}" data-bg="${b.key}" width="80" height="80"></canvas>
          </div></div>`;
      })
      .join('');
    return `<div class="row"><div class="label"><b>${i + 1}. ${c.name.replace(/^Concept \d+\s*/, '')}</b><p>${c.idea}</p></div>${panels}</div>`;
  })
  .join('');

const html = `<!doctype html><html><head><style>
  *{box-sizing:border-box} body{margin:0;width:${W}px;height:${H}px;background:#E9E8E4;font:13px/1.4 "Segoe UI",system-ui,sans-serif;color:#161615}
  header{height:64px;display:flex;align-items:center;padding:0 24px;gap:24px}
  header h1{font:600 20px "Segoe UI";margin:0} header span{color:#57564F}
  .row{display:grid;grid-template-columns:200px repeat(3,1fr);height:${ROW}px;gap:8px;padding:0 16px 8px}
  .label{padding:16px 12px} .label b{font-size:15px} .label p{margin:6px 0 0;color:#57564F}
  .panel{position:relative;border-radius:10px;overflow:hidden;display:flex;align-items:center;gap:16px;padding:0 16px}
  .grain{position:absolute;inset:0;${GRAIN_CSS}pointer-events:none}
  .panel img,.panel canvas{position:relative}
  .small{display:flex;align-items:center;gap:14px}
  .zoom{image-rendering:pixelated;outline:1px dashed rgba(128,128,128,.5)}
</style></head><body>
<header><h1>Polishot mark concepts</h1><span>preview (512 master) / 64 / 32 / 16 px / 16 px zoomed 5x, on light, dark, ember</span></header>
${rows}
<script>
  window.__ready = Promise.all([...document.querySelectorAll('canvas.zoom')].map(c => new Promise(res => {
    const img = new Image(); img.onload = () => {
      const s = document.createElement('canvas'); s.width = s.height = 16;
      s.getContext('2d').drawImage(img, 0, 0, 16, 16);
      const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
      const bg = c.dataset.bg === 'light' ? '#FAFAF9' : c.dataset.bg === 'dark' ? '#0C0C0B' : '#3a1709';
      x.fillStyle = bg; x.fillRect(0, 0, 80, 80); x.drawImage(s, 0, 0, 80, 80); res();
    }; img.src = c.dataset.src;
  })));
</script></body></html>`;

const r = await openRenderer();
writeFileSync(resolve(dir, 'sheet.png'), await r.htmlToPng(html, W, H));
await r.close();
console.log(`wrote ${resolve(dir, 'sheet.png')} (${W}x${H})`);
