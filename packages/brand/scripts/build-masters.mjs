// Builds the vector masters in packages/brand/assets from the single geometry source
// (scripts/lib/mark.mjs) and Instrument Serif outlines (no runtime font dependency).
// Usage: node packages/brand/scripts/build-masters.mjs
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRAND_DIR, REPO_DIR } from './lib/browser.mjs';
import { ACCENT, ACCENT_DARK, INK, INK_DARK, markElements, markPaths, monoElements, svgDoc } from './lib/mark.mjs';
import { loadFont, outlineText } from './lib/ttf.mjs';

const A = (p) => resolve(BRAND_DIR, 'assets', p);
const FONT = resolve(REPO_DIR, 'apps/android/app/src/main/res/font/instrument_serif.ttf');
const font = loadFont(FONT);

// ---- Mark -------------------------------------------------------------------------------
writeFileSync(A('logo-mark.svg'), svgDoc(64, 64, markElements()));
writeFileSync(A('logo-mark-mono.svg'), svgDoc(64, 64, monoElements({}, 'currentColor')));

// ---- Wordmark ---------------------------------------------------------------------------
// The mark spans y 8.4..56.6 on its grid (48u). Lettering: cap height 37.4u (font size 52u,
// Instrument Serif caps = 0.72 em), baseline on the stem foot, so the tilted print rises
// above the cap line like a print lifted off the page. Spacing tuned by eye at 24-96 px.
const WM = {
  size: 52,
  baseline: 56.6,
  gap: 13, // mark right edge (52.5) to the P stem
  tracking: 0.004,
  kern: { Po: -0.012, ol: 0.004, li: 0.006, is: 0.004, sh: -0.004, ho: -0.006, ot: -0.016 },
};
function wordmark(ink, accent, { pad = 0, wordColor = ink } = {}) {
  const markRight = 52.5;
  const pLeftBearing = (19 / 1000) * WM.size;
  const textX = markRight + WM.gap - pLeftBearing;
  const t = outlineText(font, 'Polishot', { size: WM.size, x: textX, baseline: WM.baseline, tracking: WM.tracking, kern: WM.kern });
  const tRightBearing = ((259 - 245) / 1000) * WM.size;
  const left = 10.5; // mark bbox left
  const w = textX + t.width - tRightBearing - left;
  const top = 8;
  const h = 57 - top;
  const body =
    `<g transform="translate(${pad - left} ${pad - top})">${markElements({}, { ink, accent })}` +
    `<path fill="${wordColor}" d="${t.d}"/></g>`;
  const W = Math.ceil(w + pad * 2);
  const H = Math.ceil(h + pad * 2);
  return { W, H, body };
}
{
  const { W, H, body } = wordmark(INK, ACCENT);
  writeFileSync(A('logo-wordmark.svg'), svgDoc(W, H, body));
}
// Lockups include the clear space (= the window height, 15u ~ 0.3 x mark height) built in.
for (const [name, ink, accent] of [
  ['logo-lockup-light.svg', INK, ACCENT],
  ['logo-lockup-dark.svg', INK_DARK, ACCENT_DARK],
]) {
  const { W, H, body } = wordmark(ink, accent, { pad: 15 });
  writeFileSync(A(name), svgDoc(W, H, body));
}

// ---- App icon (1024 master) -------------------------------------------------------------
const TILE_BG = '#141311';
export function appIconSvg({ size = 1024, small = false, square = false } = {}) {
  const S = 1024;
  const r = square ? 0 : small ? 200 : 228;
  const markScale = small ? 13.6 : 11.6; // 48u mark -> 64% / 54% of the tile height
  const t = (S - 64 * markScale) / 2;
  const p = markPaths({ s: markScale, tx: t, ty: t });
  const defs =
    `<defs>` +
    `<radialGradient id="hl" cx="50%" cy="0%" r="95%"><stop offset="0" stop-color="#3A332C"/><stop offset=".55" stop-color="#1E1C19"/><stop offset="1" stop-color="${TILE_BG}"/></radialGradient>` +
    `<radialGradient id="ember" cx="22%" cy="100%" r="70%"><stop offset="0" stop-color="#C8471D" stop-opacity=".28"/><stop offset="1" stop-color="#C8471D" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".14"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    (small ? '' : `<filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="14"/></filter>`) +
    `</defs>`;
  const tile =
    `<rect width="${S}" height="${S}" rx="${r}" fill="url(#hl)"/>` +
    `<rect width="${S}" height="${S}" rx="${r}" fill="url(#ember)"/>` +
    (square ? '' : `<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${r - 3}" fill="none" stroke="url(#rim)" stroke-width="6"/>`);
  const shadow = small ? '' : `<path d="${p.outer}" fill="#000" opacity=".45" filter="url(#sh)" transform="translate(10 22)"/>`;
  const mark =
    `<path fill="${INK_DARK}" d="${p.stem}"/>` + shadow + `<path fill="${ACCENT_DARK}" fill-rule="evenodd" d="${p.print}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${size}" height="${size}">${defs}${tile}${mark}</svg>\n`;
}
writeFileSync(A('app-icon.svg'), appIconSvg());
writeFileSync(A('app-icon-small.svg'), appIconSvg({ small: true }));
// Full-bleed square for platforms that apply their own mask (iOS apple-icon, Play/MS Store).
writeFileSync(A('app-icon-square.svg'), appIconSvg({ square: true }));

// ---- Android adaptive (108 dp canvas, 66 dp safe zone) ----------------------------------
// The mark's bbox diagonal is 63.5u at scale 1; at 0.84 it is 53.3 dp, well inside the 66 dp
// safe circle, and the mark is ~40 dp tall: the same proportion as the 1024 tile inside the
// 72 dp visible viewport.
export const ADAPTIVE_SCALE = 0.84;
const at = 54 - 32 * ADAPTIVE_SCALE;
export const adaptivePaths = () => markPaths({ s: ADAPTIVE_SCALE, tx: at, ty: at });
{
  const p = adaptivePaths();
  writeFileSync(
    A('android-adaptive-foreground.svg'),
    svgDoc(108, 108, `<path fill="${INK_DARK}" d="${p.stem}"/><path fill="${ACCENT_DARK}" fill-rule="evenodd" d="${p.print}"/>`),
  );
  writeFileSync(
    A('android-adaptive-background.svg'),
    svgDoc(
      108,
      108,
      `<defs><radialGradient id="hl" cx="50%" cy="0%" r="95%"><stop offset="0" stop-color="#3A332C"/><stop offset=".55" stop-color="#1E1C19"/><stop offset="1" stop-color="${TILE_BG}"/></radialGradient>` +
        `<radialGradient id="ember" cx="22%" cy="100%" r="70%"><stop offset="0" stop-color="#C8471D" stop-opacity=".28"/><stop offset="1" stop-color="#C8471D" stop-opacity="0"/></radialGradient></defs>` +
        `<rect width="108" height="108" fill="url(#hl)"/><rect width="108" height="108" fill="url(#ember)"/>`,
    ),
  );
  writeFileSync(A('android-adaptive-monochrome.svg'), svgDoc(108, 108, monoElements({ s: ADAPTIVE_SCALE, tx: at, ty: at }, '#000000')));
}
console.log('masters written to', A(''));
export { TILE_BG };
