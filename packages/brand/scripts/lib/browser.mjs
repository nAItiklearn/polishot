// Shared headless-Chromium helpers for the brand scripts.
// Playwright is resolved from @polishot/brand first, then from packages/editor
// (which pins @playwright/test 1.65.0), so the brand package needs no extra deps.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const BRAND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REPO_DIR = resolve(BRAND_DIR, '../..');

function loadChromium() {
  const bases = [
    resolve(BRAND_DIR, 'package.json'),
    resolve(REPO_DIR, 'packages/editor/package.json'),
    resolve(REPO_DIR, 'apps/web/package.json'),
  ];
  for (const base of bases) {
    const req = createRequire(base);
    for (const id of ['playwright', '@playwright/test']) {
      try {
        return req(id).chromium;
      } catch {
        /* try next */
      }
    }
  }
  throw new Error('Playwright not found. Run `pnpm install` at the repo root.');
}

/** Opens one browser for a batch of renders. Call close() when done. */
export async function openRenderer() {
  const chromium = loadChromium();
  const browser = await chromium.launch();
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();

  /** Rasterizes an SVG string to a transparent PNG Buffer of size x size. */
  async function svgToPng(svg, size) {
    const html = `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;background:transparent}
      img{display:block;width:${size}px;height:${size}px}
    </style></head><body><img id="i" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(html);
    await page.waitForFunction(() => {
      const i = document.getElementById('i');
      return i && i.complete && i.naturalWidth > 0;
    });
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }

  /** Renders an arbitrary HTML page at width x height to a PNG Buffer. */
  async function htmlToPng(html, width, height) {
    await page.setViewportSize({ width, height });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => (window.__ready ? window.__ready : Promise.resolve()));
    return page.screenshot({ clip: { x: 0, y: 0, width, height } });
  }

  return { svgToPng, htmlToPng, close: () => browser.close() };
}

/** Theme swaps for masters authored with light-theme tokens. */
export const INK_LIGHT = '#161615';
export const ACCENT_LIGHT = '#C8471D';
export function forDark(svg) {
  return svg.replaceAll(INK_LIGHT, '#EDECE8').replaceAll(ACCENT_LIGHT, '#EE7444');
}

/** A CSS background that approximates the website's grainy ember/gold shader. */
export const EMBER_BG = `
  background:
    radial-gradient(60% 70% at 18% 85%, rgba(200,71,29,.55), transparent 70%),
    radial-gradient(45% 55% at 85% 15%, rgba(214,150,64,.35), transparent 70%),
    radial-gradient(80% 80% at 60% 60%, rgba(120,36,12,.45), transparent 75%),
    #0C0C0B;`;
export const GRAIN_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 0'/></filter><rect width='200' height='200' filter='url(%23n)'/></svg>`;
export const GRAIN_CSS = `background-image:url("data:image/svg+xml;utf8,${GRAIN_SVG}");opacity:.18;mix-blend-mode:overlay;`;
