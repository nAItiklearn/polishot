import { expect, test } from '@playwright/test';

/**
 * The site moved to plain paper (owner direction, 2026-11-11), so no page runs a WebGL background any more.
 * What must hold: no page creates a canvas or a WebGL context, and the decorative layers stay hidden from
 * assistive tech.
 */
test.describe('backgrounds', () => {
  for (const path of ['/', '/features', '/pricing', '/download', '/privacy']) {
    test(`${path} draws no WebGL background`, async ({ page }) => {
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        (window as unknown as { __webgl: number }).__webgl = 0;
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          type: string,
          ...rest: unknown[]
        ) {
          if (type.startsWith('webgl')) (window as unknown as { __webgl: number }).__webgl++;
          return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
        } as typeof HTMLCanvasElement.prototype.getContext;
      });
      await page.goto(path);
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => (window as unknown as { __webgl: number }).__webgl)).toBe(0);
      for (const surface of await page.locator('.shader-surface').all()) {
        await expect(surface).toHaveAttribute('aria-hidden', 'true');
      }
    });
  }
});
