// Renders assets/final-preview.png: mark, wordmark and app icon on light, dark and ember,
// with true-pixel 32/16 px renders and a 6x zoom of the 16 px raster.
// Usage: node packages/brand/scripts/final-preview.mjs   (run build-masters.mjs first)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRAND_DIR, EMBER_BG, GRAIN_CSS, forDark, openRenderer } from './lib/browser.mjs';

const A = (p) => resolve(BRAND_DIR, 'assets', p);
const read = (p) => readFileSync(A(p), 'utf8');
const uri = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
const mark = read('logo-mark.svg');
const wmLight = read('logo-wordmark.svg');
const wmDark = forDark(wmLight);
const icon = read('app-icon.svg');
const iconSmall = read('app-icon-small.svg');
const mono = read('logo-mark-mono.svg');

const rows = [
  { label: 'Light', css: 'background:#FAFAF9;', dark: false },
  { label: 'Dark', css: 'background:#0C0C0B;', dark: true },
  { label: 'Ember', css: EMBER_BG, dark: true },
];
const W = 1600;
const RH = 300;
const H = 56 + rows.length * (RH + 12) + 4;

const body = rows
  .map((r) => {
    const m = uri(r.dark ? forDark(mark) : mark);
    const wm = uri(r.dark ? wmDark : wmLight);
    const mn = uri(mono.replaceAll('currentColor', r.dark ? '#EDECE8' : '#161615'));
    return `<section style="${r.css}"><div class="grain"></div>
      <span class="lab" style="color:${r.dark ? '#A6A59F' : '#57564F'}">${r.label}</span>
      <img src="${m}" width="180" height="180">
      <div class="col"><div class="sm"><img src="${m}" width="48" height="48"><img src="${m}" width="32" height="32"><img src="${m}" width="16" height="16"></div>
        <div class="sm"><img src="${mn}" width="32" height="32"><img src="${mn}" width="16" height="16"><canvas data-src="${mn}" width="96" height="96"></canvas></div></div>
      <div class="col wm"><img src="${wm}" height="88"><img src="${wm}" height="32"><img src="${wm}" height="20"></div>
      <img src="${uri(icon)}" width="200" height="200">
      <div class="col"><div class="sm"><img src="${uri(icon)}" width="64" height="64"><img src="${uri(iconSmall)}" width="32" height="32"><img src="${uri(iconSmall)}" width="16" height="16"></div>
        <div class="sm"><canvas data-src="${uri(iconSmall)}" width="96" height="96"></canvas><canvas data-src="${m}" width="96" height="96"></canvas></div></div>
    </section>`;
  })
  .join('');

const html = `<!doctype html><html><head><style>
  *{box-sizing:border-box} body{margin:0;width:${W}px;height:${H}px;background:#E9E8E4;font:13px "Segoe UI",system-ui;color:#161615;padding:0 16px}
  h1{font:600 20px "Segoe UI";margin:0;height:56px;display:flex;align-items:center}
  section{position:relative;height:${RH}px;margin-bottom:12px;border-radius:14px;overflow:hidden;display:flex;align-items:center;gap:40px;padding:0 40px}
  section>*{position:relative} .grain{position:absolute;inset:0;${GRAIN_CSS}}
  .lab{position:absolute;top:12px;left:16px;font-size:12px;letter-spacing:.06em;text-transform:uppercase}
  .col{display:flex;flex-direction:column;gap:22px} .wm{align-items:flex-start;gap:26px}
  .sm{display:flex;align-items:center;gap:18px} canvas{image-rendering:pixelated;outline:1px dashed rgba(128,128,128,.45)}
</style></head><body><h1>Polishot - final mark, wordmark and app icon</h1>${body}
<script>
  window.__ready = Promise.all([...document.querySelectorAll('canvas')].map(c => new Promise(res => {
    const img = new Image(); img.onload = () => {
      const s = document.createElement('canvas'); s.width = s.height = 16;
      s.getContext('2d').drawImage(img, 0, 0, 16, 16);
      const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(s, 0, 0, 96, 96); res();
    }; img.src = c.dataset.src;
  })));
</script></body></html>`;

const r = await openRenderer();
writeFileSync(A('final-preview.png'), await r.htmlToPng(html, W, H));
await r.close();
console.log('wrote', A('final-preview.png'), `${W}x${H}`);
