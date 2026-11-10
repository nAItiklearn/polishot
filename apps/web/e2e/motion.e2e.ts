import { expect, test, type Page } from '@playwright/test';

const longestMotionSeconds = (page: Page) =>
  page.evaluate(() => {
    const seconds = (value: string) =>
      value
        .split(',')
        .map((v) => parseFloat(v) * (v.trim().endsWith('ms') ? 0.001 : 1))
        .reduce((a, b) => Math.max(a, b), 0);
    let longest = 0;
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      longest = Math.max(longest, seconds(s.transitionDuration), seconds(s.animationDuration));
    }
    return longest;
  });

test.describe('motion', () => {
  test('normal motion stays within 150 to 200 ms', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    const duration = await page
      .getByRole('link', { name: 'Download for Windows' })
      .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
    expect(duration).toBeGreaterThanOrEqual(0.15);
    expect(duration).toBeLessThanOrEqual(0.2);

    const longest = await longestMotionSeconds(page);
    expect(longest).toBeLessThanOrEqual(0.2);
  });

  test('prefers-reduced-motion switches every transition and animation off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const path of ['/', '/features', '/pricing', '/download']) {
      await page.goto(path);
      expect(await longestMotionSeconds(page), `${path} has no perceptible motion`).toBeLessThan(0.001);
    }
  });

  test('the mobile menu does not animate under reduced motion', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile only.');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await longestMotionSeconds(page)).toBeLessThan(0.001);
  });

  test('the page does not scroll smoothly under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  });
});
