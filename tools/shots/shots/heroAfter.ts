import { openPlayground } from '../lib/playground.ts';
import type { ShotDef } from './types.ts';

/** Cover the detected items with solid bars ('bar') or a blur ('blur'). */
const COVER: 'bar' | 'blur' = 'bar';
/** Show the Free tier's small "Made with Polishot" mark. Off renders what a Pro licence exports. */
const WATERMARK = true;

/**
 * hero-after: the same capture as hero-before after one pass through the real editor: auto-balance trim,
 * even padding, an auto background sampled from the edges, rounded corners and a soft shadow, with the e-mail
 * address and the key covered. Exported through `editor.export()` (the same code path as the Save button) as
 * a 16:10 canvas at 2x, so capture.ts downsamples 3200 x 2000 to the manifest's 1600 x 1000.
 */
export const heroAfter: ShotDef = {
  name: 'hero-after',
  async run({ browser, manifest }) {
    const spec = manifest.shots['hero-after']!;
    const { context, page } = await openPlayground(browser, 'settings');
    try {
      // Run the redaction scan the way a user would: the panel's own button, then its own cover buttons.
      await page.getByRole('button', { name: 'Find sensitive data' }).click();
      await page.locator('.pe-detlist li').first().waitFor();
      const found = await page.locator('.pe-detlist li').count();
      if (found !== 2) throw new Error(`hero sample should have 2 sensitive items (email, key), the editor found ${found}`);
      await page.getByRole('button', { name: COVER === 'bar' ? 'Bars' : 'Blur all', exact: true }).click();

      const base64 = await page.evaluate(
        async ({ width, height, watermark }) => {
          const { editor } = window.__polishot!;
          editor.update({ preset: 'custom', custom: { width, height } });
          editor.setLicensed(!watermark);
          const blob = await editor.export({ format: 'png', quality: 1, scale: 2, licensed: !watermark });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(bin);
        },
        { width: spec.width, height: spec.height, watermark: WATERMARK },
      );
      return Buffer.from(base64, 'base64');
    } finally {
      await context.close();
    }
  },
};
