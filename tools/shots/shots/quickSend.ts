import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDesktop, screenshotPng } from '../lib/desktop.ts';
import { OUT_DIR, TOOL_DIR } from '../lib/paths.ts';
import type { ShotDef } from './types.ts';

/**
 * quick-send: PC and phone side by side, both on the six-digit pairing code, with the "Received from" notification
 * and the image preview. The scene itself is scenes/quick-send.html (see its header for what is a real capture and
 * what is laid out from the apps' own copy and colours); this recipe produces the one real piece it embeds, the
 * Polishot desktop window showing the phone screenshot, then renders the scene at 2x.
 */
export const quickSend: ShotDef = {
  name: 'quick-send',
  async run({ browser, theme }) {
    // 1. The desktop UI (mock mode) with the phone screenshot open, as it looks right after a transfer arrives.
    const app = await openDesktop(browser, 'phone', { theme, expectFound: 0 });
    let appPng: Buffer;
    try {
      appPng = await screenshotPng(app.page);
    } finally {
      await app.context.close();
    }
    const sceneDir = join(OUT_DIR, 'scene');
    mkdirSync(sceneDir, { recursive: true });
    writeFileSync(join(sceneDir, 'pc-app.png'), appPng);

    // 2. The scene: 1600 x 1000 CSS px at 2x, so capture.ts downsamples a 3200 x 2000 image.
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light' });
    try {
      const page = await context.newPage();
      await page.goto(pathToFileURL(join(TOOL_DIR, 'scenes', 'quick-send.html')).href);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0));
      await page.waitForTimeout(200);
      return await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
    } finally {
      await context.close();
    }
  },
};
