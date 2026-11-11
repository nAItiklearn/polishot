import { expect, test, type Locator, type Page } from '@playwright/test';

async function focusRing(locator: Locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor };
  });
}

async function tabTo(page: Page, target: Locator, maxPresses = 24) {
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) return i + 1;
  }
  throw new Error('Focus never reached the target with Tab.');
}

test.describe('keyboard only', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'Keyboard paths are checked on desktop.');
  });

  test('Tab reaches both hero actions, each with a visible focus ring', async ({ page }) => {
    await page.goto('/');
    const windows = page.getByRole('link', { name: 'Download for Windows' });
    const android = page.getByRole('link', { name: 'Get it on Android' });

    await tabTo(page, windows);
    await expect(windows).toBeFocused();
    const ring = await focusRing(windows);
    expect(ring.style).toBe('solid');
    expect(ring.width).toBeGreaterThanOrEqual(2);
    expect(ring.color).not.toBe('rgba(0, 0, 0, 0)');

    await page.keyboard.press('Tab');
    await expect(android).toBeFocused();
    expect((await focusRing(android)).width).toBeGreaterThanOrEqual(2);

    // Enter on the focused link navigates.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/download#android');
  });

  test('every control on the first screen shows a focus ring', async ({ page }) => {
    await page.goto('/');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const active = page.locator(':focus');
      await expect(active).toHaveCount(1);
      const ring = await focusRing(active);
      expect(ring.style, `control ${i + 1} has an outline`).toBe('solid');
      expect(ring.width, `control ${i + 1} outline width`).toBeGreaterThanOrEqual(2);
    }
  });

  test('the first Tab stop is the skip link', async ({ page }) => {
    await page.goto('/features');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });

  test('the FAQ works from the keyboard', async ({ page }) => {
    await page.goto('/pricing');
    const question = page.getByText('Do I need to be online to activate a license?');
    await tabTo(page, question.locator('xpath=ancestor-or-self::summary'));
    await page.keyboard.press('Enter');
    await expect(page.getByText(/works offline/)).toBeVisible();
  });
});
