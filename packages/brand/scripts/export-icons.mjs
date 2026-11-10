// Exports raster icons from the SVG masters in packages/brand/assets.
//
// Usage (from the repo root):
//   node packages/brand/scripts/export-icons.mjs              -> assets/png/*.png + assets/icon.ico
//   node packages/brand/scripts/export-icons.mjs --tauri      -> also apps/desktop/src-tauri/icons/
//   node packages/brand/scripts/export-icons.mjs --web        -> also apps/web/app/{icon.svg,apple-icon.png,favicon.ico}
//   node packages/brand/scripts/export-icons.mjs --android    -> also apps/android/app/src/main/res/...
//   node packages/brand/scripts/export-icons.mjs --all        -> all of the above
//   add --stage <dir> to write the app files under <dir>/apps/... instead (review before integrating).
//   add --dry-run to print the app files that would be written without writing them.
//
// The masters are read from disk (edit them, or regenerate with build-masters.mjs).
// Small sizes (16/24/32) use app-icon-small.svg: a larger mark and no shadow, for legibility.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { BRAND_DIR, REPO_DIR, openRenderer } from './lib/browser.mjs';

const args = new Set(process.argv.slice(2));
const all = args.has('--all');
const want = { tauri: all || args.has('--tauri'), web: all || args.has('--web'), android: all || args.has('--android') };
const dry = args.has('--dry-run');
const argv = process.argv.slice(2);
const stageAt = argv.indexOf('--stage');
// --stage <dir>: write the app files under <dir>/apps/... instead of the real app folders (for review).
const ROOT = stageAt >= 0 && argv[stageAt + 1] ? resolve(argv[stageAt + 1]) : REPO_DIR;

const A = (p) => resolve(BRAND_DIR, 'assets', p);
const read = (p) => readFileSync(A(p), 'utf8');
const MASTER = {
  icon: read('app-icon.svg'),
  iconSmall: read('app-icon-small.svg'),
  iconSquare: read('app-icon-square.svg'),
  mark: read('logo-mark.svg'),
  mono: read('logo-mark-mono.svg'),
  fg: read('android-adaptive-foreground.svg'),
  bg: read('android-adaptive-background.svg'),
  monoAdaptive: read('android-adaptive-monochrome.svg'),
};
const TILE_BG = '#141311';
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 256];

/** Nests a full SVG document inside another at (x, y, w, h). */
function nest(svg, x, y, w, h) {
  return svg
    .replace(/<\?xml[^>]*>/, '')
    .replace(/^<svg([^>]*?)\swidth="[^"]*"\sheight="[^"]*"/, '<svg$1')
    .replace(/^<svg/, `<svg x="${x}" y="${y}" width="${w}" height="${h}"`);
}
const wrap = (S, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">${body}</svg>`;
const iconFor = (size) => (size <= 32 ? MASTER.iconSmall : MASTER.icon);

/** PNG-in-ICO container (Vista+). entries: [{ size, png }] */
export function buildIco(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, png }, i) => {
    const o = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, o);
    head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt8(0, o + 2);
    head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

/** PNG-in-ICNS container. entries: [{ type: 'ic07', png }] */
function buildIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

const written = [];
function out(path, data) {
  written.push(path);
  if (dry && !path.startsWith(A(''))) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

const r = await openRenderer();
const cache = new Map();
async function png(svg, size) {
  const key = `${size}:${svg}`;
  if (!cache.has(key)) cache.set(key, await r.svgToPng(svg, size));
  return cache.get(key);
}
const iconPng = (size) => png(iconFor(size), size);

try {
  // ---- assets/png + assets/icon.ico ------------------------------------------------------
  for (const s of PNG_SIZES) {
    out(A(`png/icon-${s}.png`), await iconPng(s));
    out(A(`png/mark-${s}.png`), await png(MASTER.mark, s));
    out(A(`png/mark-mono-${s}.png`), await png(MASTER.mono.replaceAll('currentColor', '#161615'), s));
  }
  // Full-bleed squares for store listings (Play Console 512, Microsoft Store 1024).
  for (const s of [512, 1024]) out(A(`png/icon-square-${s}.png`), await png(MASTER.iconSquare, s));
  const ico = buildIco(await Promise.all(ICO_SIZES.map(async (s) => ({ size: s, png: await iconPng(s) }))));
  out(A('icon.ico'), ico);

  // ---- Tauri -----------------------------------------------------------------------------
  if (want.tauri) {
    const T = (p) => resolve(ROOT, 'apps/desktop/src-tauri/icons', p);
    out(T('32x32.png'), await iconPng(32));
    out(T('64x64.png'), await iconPng(64));
    out(T('128x128.png'), await iconPng(128));
    out(T('128x128@2x.png'), await iconPng(256));
    out(T('icon.png'), await iconPng(1024));
    out(T('icon.ico'), ico);
    out(T('icon.icns'), buildIcns([
      { type: 'ic07', png: await iconPng(128) },
      { type: 'ic08', png: await iconPng(256) },
      { type: 'ic09', png: await iconPng(512) },
      { type: 'ic10', png: await iconPng(1024) },
    ]));
    for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) out(T(`Square${s}x${s}Logo.png`), await iconPng(s));
    out(T('StoreLogo.png'), await iconPng(50));
    // Tray: single-colour mark. tray.png is persimmon (readable on light and dark taskbars);
    // tray-light / tray-dark are for theme-aware switching (light taskbar / dark taskbar).
    const tray = (c) => MASTER.mono.replaceAll('currentColor', c);
    out(T('tray.png'), await png(tray('#C8471D'), 32));
    out(T('tray-light.png'), await png(tray('#161615'), 32));
    out(T('tray-dark.png'), await png(tray('#EDECE8'), 32));
  }

  // ---- Web (Next.js app router file conventions) -----------------------------------------
  if (want.web) {
    const W = (p) => resolve(ROOT, 'apps/web/app', p);
    out(W('icon.svg'), MASTER.iconSmall);
    // apple-icon: full-bleed square (iOS applies its own mask).
    out(W('apple-icon.png'), await png(MASTER.iconSquare, 180));
    out(W('favicon.ico'), buildIco(await Promise.all([16, 32, 48].map(async (s) => ({ size: s, png: await iconPng(s) })))));
  }

  // ---- Android ---------------------------------------------------------------------------
  if (want.android) {
    const RES = (p) => resolve(ROOT, 'apps/android/app/src/main/res', p);
    const dens = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
    // Legacy launcher: adaptive layers composited, then masked (rounded square / circle).
    for (const [d, S] of Object.entries(dens)) {
      // 108 dp canvas shown through a 72 dp viewport: scale layers by 1.5 and centre.
      const k = S * 1.5;
      const o = -(k - S) / 2;
      const inner = nest(MASTER.bg, o, o, k, k) + nest(MASTER.fg, o, o, k, k);
      out(RES(`mipmap-${d}/ic_launcher.png`), await png(wrap(S, `<clipPath id="c"><rect width="${S}" height="${S}" rx="${S * 0.22}"/></clipPath><g clip-path="url(#c)">${inner}</g>`), S));
      out(RES(`mipmap-${d}/ic_launcher_round.png`), await png(wrap(S, `<clipPath id="c"><circle cx="${S / 2}" cy="${S / 2}" r="${S / 2}"/></clipPath><g clip-path="url(#c)">${inner}</g>`), S));
    }
    const paths = (svg) => [...svg.matchAll(/<path fill="([^"]+)"(?: fill-rule="evenodd")? d="([^"]+)"/g)].map((m) => ({ fill: m[1], d: m[2], evenodd: m[0].includes('evenodd') }));
    const vector = (body, extraNs = '') =>
      `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by packages/brand/scripts/export-icons.mjs. Do not edit by hand. -->\n` +
      `<vector xmlns:android="http://schemas.android.com/apk/res/android"${extraNs}\n    android:width="108dp"\n    android:height="108dp"\n    android:viewportWidth="108"\n    android:viewportHeight="108">\n${body}</vector>\n`;
    const pathXml = ({ fill, d, evenodd }) =>
      `    <path\n        android:fillColor="${fill}"${evenodd ? '\n        android:fillType="evenOdd"' : ''}\n        android:pathData="${d}" />\n`;
    out(RES('drawable/ic_launcher_foreground.xml'), vector(paths(MASTER.fg).map(pathXml).join('')));
    out(RES('drawable/ic_launcher_monochrome.xml'), vector(paths(MASTER.monoAdaptive).map(pathXml).join('')));
    const grad = (cx, cy, r, stops) =>
      `            <gradient android:type="radial" android:centerX="${cx}" android:centerY="${cy}" android:gradientRadius="${r}">\n` +
      stops.map(([o, c]) => `                <item android:offset="${o}" android:color="${c}" />\n`).join('') +
      `            </gradient>\n`;
    const gpath = (g) => `    <path android:pathData="M0,0h108v108h-108z">\n        <aapt:attr name="android:fillColor">\n${g}        </aapt:attr>\n    </path>\n`;
    out(
      RES('drawable/ic_launcher_background.xml'),
      vector(
        `    <path android:fillColor="${TILE_BG}" android:pathData="M0,0h108v108h-108z" />\n` +
          gpath(grad(54, 0, 102.6, [[0, '#FF3A332C'], [0.55, '#FF1E1C19'], [1, '#FF141311']])) +
          gpath(grad(23.76, 108, 75.6, [[0, '#47C8471D'], [1, '#00C8471D']])),
        '\n    xmlns:aapt="http://schemas.android.com/aapt"',
      ),
    );
    const adaptive =
      `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n` +
      `    <background android:drawable="@drawable/ic_launcher_background" />\n` +
      `    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n` +
      `    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />\n</adaptive-icon>\n`;
    out(RES('mipmap-anydpi/ic_launcher.xml'), adaptive);
    out(RES('mipmap-anydpi/ic_launcher_round.xml'), adaptive);
  }
} finally {
  await r.close();
}

for (const p of written) console.log(`${dry && !p.startsWith(A('')) ? '[dry] ' : ''}${relative(REPO_DIR, p)}`);
