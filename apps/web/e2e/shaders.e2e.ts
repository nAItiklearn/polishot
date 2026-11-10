import { expect, test, type Page } from '@playwright/test';

/**
 * The live backgrounds are WebGL2 and headless CI may not provide it, so every assertion about drawing
 * accepts "unsupported". What must hold either way: the CSS fallback is there, the canvas is hidden from
 * assistive tech, nothing logs an error, and reduced motion never animates.
 */
const heroState = (page: Page) =>
  page.locator('.shader-surface[data-variant="orbs"]').first().getAttribute('data-shader-state');

test.describe('shader backgrounds', () => {
  test('the hero has a CSS fallback behind an aria-hidden shader surface', async ({ page }) => {
    await page.goto('/');
    const surface = page.locator('.shader-surface[data-variant="orbs"]').first();
    await expect(surface).toHaveAttribute('aria-hidden', 'true');
    const background = await surface.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(background).toContain('radial-gradient');
  });

  test('starts after idle, and only on a surface that is near the viewport', async ({ page }) => {
    await page.goto('/');
    await expect
      .poll(() => heroState(page), { message: 'hero shader leaves "pending"' })
      .toMatch(/^(running|unsupported)$/);

    // The gold band at the bottom has not been near the viewport, so it has not been started.
    const gold = page.locator('.shader-surface[data-variant="gold"]');
    await expect(gold).toHaveAttribute('data-shader-state', 'pending');
    await expect(gold.locator('canvas')).toHaveCount(0);
  });

  test('draws at reduced resolution when WebGL is available', async ({ page, isMobile }) => {
    await page.goto('/');
    await expect.poll(() => heroState(page)).toMatch(/^(running|unsupported)$/);
    test.skip((await heroState(page)) === 'unsupported', 'WebGL2 is not available in this browser.');

    const canvas = page.locator('.shader-surface[data-variant="orbs"] canvas').first();
    await expect(canvas).toHaveAttribute('data-ready', '');
    const sizes = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, dpr: window.devicePixelRatio };
    });
    const expectedScale = Math.min(sizes.dpr, 1.5) * 0.5;
    expect(sizes.w).toBeLessThanOrEqual(Math.ceil(sizes.cw * expectedScale) + 1);
    expect(sizes.h).toBeLessThanOrEqual(Math.ceil(sizes.ch * expectedScale) + 1);
    expect(sizes.w).toBeGreaterThan(100);
    expect(isMobile || sizes.w < sizes.cw).toBe(true);
  });

  test('pauses when scrolled away and resumes when it comes back', async ({ page }) => {
    await page.goto('/');
    await expect.poll(() => heroState(page)).toMatch(/^(running|unsupported)$/);
    test.skip((await heroState(page)) === 'unsupported', 'WebGL2 is not available in this browser.');

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => heroState(page)).toBe('paused');
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => heroState(page)).toBe('running');
  });

  test('pauses in a hidden tab', async ({ page }) => {
    await page.goto('/');
    await expect.poll(() => heroState(page)).toMatch(/^(running|unsupported)$/);
    test.skip((await heroState(page)) === 'unsupported', 'WebGL2 is not available in this browser.');

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => heroState(page)).toBe('paused');
  });

  test('reduced motion draws one still frame and never animates', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect.poll(() => heroState(page)).toMatch(/^(static|unsupported)$/);
    expect(await heroState(page)).not.toBe('running');
  });

  test('a page without a shader variant stays a still band and never creates a canvas', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.locator('.shader-surface[data-variant="still"]')).toHaveCount(1);
  });

  test('a failed context leaves the page usable and the CSS fallback visible', async ({ page }) => {
    await page.addInitScript(() => {
      // Simulate a browser with no WebGL2.
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === 'webgl2') return null;
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect.poll(() => heroState(page)).toBe('unsupported');
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.shader-surface[data-variant="orbs"] canvas')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
