import { expect, test } from '@playwright/test';

test.describe('header', () => {
  test('primary links go where they say', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The desktop nav is hidden on small screens; see the mobile menu test.');
    for (const [label, href] of [
      ['Features', '/features'],
      ['Pricing', '/pricing'],
      ['Changelog', '/changelog'],
    ] as const) {
      await page.goto('/');
      await page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: label })
        .click();
      await expect(page).toHaveURL(href);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(
        page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: label }),
      ).toHaveAttribute('aria-current', 'page');
    }
  });

  test('the logo returns home and the Download button opens the download page', async ({
    page,
    isMobile,
  }) => {
    await page.goto('/pricing');
    await page.getByRole('link', { name: /home/i }).first().click();
    await expect(page).toHaveURL('/');

    test.skip(isMobile, 'The header Download button is desktop-only.');
    await page.getByRole('banner').getByRole('link', { name: 'Download' }).click();
    await expect(page).toHaveURL('/download');
  });

  test('the mobile menu lists every page, closes on Escape and returns focus', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'Mobile only.');
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Open menu' });
    await trigger.click();

    const menu = page.getByRole('dialog');
    await expect(menu).toBeVisible();
    for (const label of ['Features', 'Pricing', 'Changelog', 'Download', 'Web editor']) {
      await expect(menu.getByRole('link', { name: label })).toBeVisible();
    }

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.getByRole('dialog').getByRole('link', { name: 'Pricing' }).click();
    await expect(page).toHaveURL('/pricing');
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});

test.describe('footer', () => {
  const INTERNAL: Array<[string, string]> = [
    ['Features', '/features'],
    ['Pricing', '/pricing'],
    ['Download', '/download'],
    ['Changelog', '/changelog'],
    ['Web editor', '/editor'],
    ['Privacy', '/privacy'],
    ['Terms', '/terms'],
  ];

  for (const [label, href] of INTERNAL) {
    test(`footer link "${label}" opens ${href}`, async ({ page }) => {
      await page.goto('/');
      await page.getByRole('contentinfo').getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(href);
      await expect(page.locator('h1')).toHaveCount(1);
    });
  }

  test('the site never links to the private source repository', async ({ page }) => {
    for (const path of ['/', '/download', '/privacy']) {
      await page.goto(path);
      await expect(page.locator('a[href*="github.com"]')).toHaveCount(0);
    }
  });

  test('the version in the footer links to the changelog', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('contentinfo').getByRole('link', { name: /^v\d/ }).click();
    await expect(page).toHaveURL('/changelog');
  });
});

test.describe('home actions', () => {
  test('the hero actions lead to the platform sections of the download page', async ({ page }) => {
    await page.goto('/');
    const windows = page.getByRole('link', { name: 'Download for Windows' });
    const android = page.getByRole('link', { name: 'Get it on Android' });
    await expect(windows).toHaveAttribute('href', '/download#windows');
    await expect(android).toHaveAttribute('href', '/download#android');
    await windows.click();
    await expect(page).toHaveURL('/download#windows');
    await expect(page.locator('#windows')).toBeVisible();
  });
});
