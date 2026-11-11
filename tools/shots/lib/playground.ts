import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { sampleJson, samplePng, type SampleName } from '../samples/render.ts';
import { PLAYGROUND_URL } from './servers.ts';

export interface PlaygroundSession {
  context: BrowserContext;
  page: Page;
}

/**
 * Opens the editor playground (packages/editor/playground), which hosts the real editor component and exposes
 * `window.__polishot` ({ editor, words, ... }) for tests, then loads one of the samples into it exactly as a
 * host would: decoded image to `editor.load`, OCR words to the redaction panel's scanner.
 */
export async function openPlayground(
  browser: Browser,
  sample: SampleName,
  opts: { viewport?: { width: number; height: number }; scale?: number } = {},
): Promise<PlaygroundSession> {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: opts.scale ?? 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.warn(`    [page error] ${e.message}`));
  const png = readFileSync(samplePng(sample));
  const json = readFileSync(sampleJson(sample));
  await page.route('**/__shots/sample.png', (route) => route.fulfill({ body: png, contentType: 'image/png' }));
  await page.route('**/__shots/sample.json', (route) => route.fulfill({ body: json, contentType: 'application/json' }));

  await page.goto(`${PLAYGROUND_URL}/?theme=light`, { timeout: 180_000 });
  await page.locator('.pe-canvas canvas').first().waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__polishot?.editor));
  await page.evaluate(async () => {
    const api = window.__polishot!;
    const meta = (await (await fetch('/__shots/sample.json')).json()) as { words: typeof api.words };
    const bitmap = await createImageBitmap(await (await fetch('/__shots/sample.png')).blob());
    api.words = meta.words;
    api.image = { id: 'shots-sample', width: bitmap.width, height: bitmap.height, element: bitmap };
    api.editor.load(api.image);
  });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}
