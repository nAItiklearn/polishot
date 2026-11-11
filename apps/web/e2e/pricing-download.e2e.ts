import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const BASE = process.env.NEXT_PUBLIC_DOWNLOAD_BASE_URL?.replace(/\/+$/, '');

test.describe('pricing', () => {
  test.skip(
    !!process.env.NEXT_PUBLIC_CHECKOUT_URL,
    'These assertions are for the not-on-sale state.',
  );

  test('the buy button is disabled and says so while the checkout URL is empty', async ({
    page,
  }) => {
    await page.goto('/pricing');
    const button = page.getByRole('button', { name: 'On sale soon' });
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(page.getByRole('link', { name: /buy a license/i })).toHaveCount(0);
    await expect(page.getByText('The free version has every feature.')).toBeVisible();
    await expect(button).toHaveAccessibleDescription(/free version has every feature/);
  });

  test('shows Pro at the price from lib/site.ts next to the free plan, with the limits and the update window', async ({
    page,
  }) => {
    await page.goto('/pricing');
    await expect(page.getByText('$0', { exact: true })).toBeVisible();
    await expect(page.getByText('$11', { exact: true })).toBeVisible();
    await expect(page.getByText('one-time', { exact: true })).toBeVisible();
    for (const line of [
      '3 saved presets',
      'Batch beautify, up to 5 images at a time',
      'Unlimited saved presets',
      'Unlimited batch beautify',
      'No watermark on exports',
      'Your own brand mark: a logo or a line of text',
    ]) {
      await expect(page.getByText(line, { exact: true })).toBeVisible();
    }
    await expect(
      page.getByText('Keep every version released within a year of purchase, forever.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download free' })).toHaveAttribute(
      'href',
      '/download',
    );
  });

  test('FAQ answers open and close', async ({ page }) => {
    await page.goto('/pricing');
    for (const question of [
      'Do I need to be online to activate a license?',
      'How many devices can I use it on?',
      'What does the free version leave out?',
      'Can I get a refund?',
    ]) {
      const summary = page.locator('summary', { hasText: question });
      const details = page.locator('details', { has: summary });
      await expect(details).not.toHaveAttribute('open', '');
      await summary.click();
      await expect(details).toHaveAttribute('open', '');
      await summary.click();
      await expect(details).not.toHaveAttribute('open', '');
    }
  });
});

test.describe('download', () => {
  test('with a download host, links point at it with the agreed file names', async ({ page }) => {
    test.skip(!BASE, 'NEXT_PUBLIC_DOWNLOAD_BASE_URL is not set for this build.');
    await page.goto('/download');
    await expect(page.getByRole('link', { name: 'Installer (.exe)' })).toHaveAttribute(
      'href',
      `${BASE}/Polishot-Setup-x64.exe`,
    );
    await expect(page.getByRole('link', { name: 'MSI package (.msi)' })).toHaveAttribute(
      'href',
      `${BASE}/Polishot-x64.msi`,
    );
    await expect(page.getByRole('link', { name: 'Download APK (.apk)' })).toHaveAttribute(
      'href',
      `${BASE}/Polishot.apk`,
    );
  });

  test('without a download host, nothing links anywhere and the page says so', async ({ page }) => {
    test.skip(!!BASE, 'A download host is configured for this build.');
    await page.goto('/download');
    for (const name of ['Installer (.exe)', 'MSI package (.msi)', 'Download APK (.apk)']) {
      await expect(page.getByRole('button', { name })).toBeDisabled();
      await expect(page.getByRole('link', { name })).toHaveCount(0);
    }
    await expect(page.getByText(/switch on when the first release is published/)).toBeVisible();
  });

  test('warns about SmartScreen and lists system requirements for both platforms', async ({
    page,
  }) => {
    await page.goto('/download');
    await expect(page.getByText(/SmartScreen may say it protected your PC/)).toBeVisible();
    await expect(
      page.locator('#windows').getByText('Windows 10 or 11, 64-bit.').first(),
    ).toBeVisible();
    await expect(page.locator('#android').getByText('Android 10 (API 29) or later.')).toBeVisible();
  });

  test('says the release is not out while unreleased or not yet hosted', async ({ page }) => {
    const changelog = readFileSync(path.join(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8');
    const first = /^## .*$/m.exec(changelog)?.[0] ?? '';
    await page.goto('/download');
    const note = page.getByText(/is not released yet/);
    // The note stays until the changelog entry is dated AND a public download host is configured.
    if (/unreleased/i.test(first) || !BASE) await expect(note).toBeVisible();
    else await expect(note).toHaveCount(0);
  });
});
