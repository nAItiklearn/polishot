import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { sampleJson, samplePng, type SampleName } from '../samples/render.ts';
import { DESKTOP_URL } from './servers.ts';

/**
 * The preview window is 1040 x 680 in the real app (see apps/desktop/src-tauri/src/winmgr.rs). The shots use
 * 1040 x 650, which is exactly 16:10 like the manifest's 1600 x 1000, and render it at a device scale factor
 * that makes the capture 3200 x 2000, so the final downsample to 1600 x 1000 is a clean 2:1 supersample.
 */
export const APP_VIEWPORT = { width: 1040, height: 650 } as const;
export const APP_SCALE = 3200 / APP_VIEWPORT.width;

export type Theme = 'dark' | 'light';

export interface DesktopOptions {
  theme: Theme;
  /** Extra query parameters for the mock backend (see src/shared/mock/mockBackend.ts). */
  query?: Record<string, string>;
  /** How many sensitive items the sample is expected to produce; the run fails loudly if the UI disagrees. */
  expectFound?: number;
}

export interface DesktopSession {
  context: BrowserContext;
  page: Page;
}

/**
 * Replaces the mock backend's built-in sample (a generated billing page) with one of tools/shots/samples,
 * without touching any app code. The Vite dev server is intercepted at `src/shared/mock/sample.ts`: the
 * replacement module re-exports everything from the real file (so no other import can break) and overrides
 * only `makeSample`, drawing our PNG on the canvas and returning our OCR word boxes.
 */
async function installSample(page: Page, sample: SampleName): Promise<void> {
  const png = readFileSync(samplePng(sample));
  const json = readFileSync(sampleJson(sample));
  await page.route('**/__shots/sample.png', (route) => route.fulfill({ body: png, contentType: 'image/png' }));
  await page.route('**/__shots/sample.json', (route) => route.fulfill({ body: json, contentType: 'application/json' }));
  await page.route(
    (url) => url.pathname.endsWith('/src/shared/mock/sample.ts') && !url.searchParams.has('orig'),
    (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `
export * from '/src/shared/mock/sample.ts?orig';
const meta = await (await fetch('/__shots/sample.json')).json();
const bitmap = await createImageBitmap(await (await fetch('/__shots/sample.png')).blob());
export function makeSample() {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return { canvas, width: canvas.width, height: canvas.height, words: meta.words };
}
`,
      }),
  );
}

/** Opens the desktop preview in mock mode with `sample` as the first capture, and waits until it is ready. */
export async function openDesktop(browser: Browser, sample: SampleName, opts: DesktopOptions): Promise<DesktopSession> {
  const context = await browser.newContext({
    viewport: APP_VIEWPORT,
    deviceScaleFactor: APP_SCALE,
    colorScheme: opts.theme,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.warn(`    [page error] ${e.message}`));
  await installSample(page, sample);

  const query = new URLSearchParams({ mock: '1', theme: opts.theme, history: '0', ...opts.query });
  // A dev server that was just started transforms the whole module graph on the first request, which is slow.
  await page.goto(`${DESKTOP_URL}/?${query}`, { timeout: 180_000 });
  await page.locator('.pv-inspector[data-ready="true"]').waitFor({ timeout: 60_000 });
  await page.locator('.pe-canvas canvas').first().waitFor();
  await page.evaluate(() => document.fonts.ready);

  const expected = opts.expectFound;
  if (expected && expected > 0) {
    // OCR finishes a moment after the image; the "N found" chip appears once it has.
    await page.locator('.pv-found-count').waitFor({ timeout: 15_000 });
    const text = (await page.locator('.pv-found-count').innerText()).trim();
    if (!text.startsWith(`${expected} `)) {
      throw new Error(`expected "${expected} found" for sample "${sample}", the app shows "${text}"`);
    }
  } else {
    await page.waitForTimeout(900);
    if (await page.locator('.pv-found-count').count()) {
      throw new Error(`sample "${sample}" should have no sensitive data, but the app shows "${await page.locator('.pv-found-count').innerText()}"`);
    }
  }
  await settle(page);
  return { context, page };
}

/** Lets layout, fonts and canvas redraws finish; the shots are static, so a short wait is enough. */
export async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await page.waitForTimeout(ms);
}

export async function screenshotPng(page: Page): Promise<Buffer> {
  return page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
}
