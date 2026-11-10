import { expect, test, type Page } from '@playwright/test';

// Page and ink colours from @polishot/brand tokens.
const LIGHT_BG = 'rgb(250, 250, 249)';
const DARK_BG = 'rgb(12, 12, 11)';

const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// The body fades its colours over 180 ms when the theme changes; wait for the end value.
async function expectBackground(page: Page, expected: string) {
  await expect.poll(() => bodyBackground(page)).toBe(expected);
}

test.describe('theme', () => {
  test('follows the system setting by default', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    await expectBackground(page, DARK_BG);

    await page.emulateMedia({ colorScheme: 'light' });
    await expectBackground(page, LIGHT_BG);
  });

  test('the header toggle switches the theme and the choice persists across reloads', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expectBackground(page, DARK_BG);
    expect(await page.evaluate(() => localStorage.getItem('ps-theme'))).toBe('dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectBackground(page, DARK_BG);

    // Persists on another page too, and flips back.
    await page.goto('/pricing');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expectBackground(page, LIGHT_BG);
    expect(await page.evaluate(() => localStorage.getItem('ps-theme'))).toBe('light');
  });

  test('an explicit choice wins over the system setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await page.getByTestId('theme-light').click();
    await expectBackground(page, LIGHT_BG);
    await page.reload();
    await expectBackground(page, LIGHT_BG);
  });

  test('the footer switch offers System, Light and Dark, and System clears the choice', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');

    await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('theme-dark').click();
    await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByTestId('theme-system').click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect(await page.evaluate(() => localStorage.getItem('ps-theme'))).toBeNull();
    await expectBackground(page, LIGHT_BG);
  });

  test('the stored theme is applied before first paint (no flash)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ps-theme', 'dark'));
    await page.emulateMedia({ colorScheme: 'light' });
    // Stop at the first byte of HTML: the inline script in <head> must already have run by DOMContentLoaded.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  });

  test('uses no cookies', async ({ page, context }) => {
    await page.goto('/');
    await page.getByTestId('theme-toggle').click();
    expect(await context.cookies()).toEqual([]);
  });
});
