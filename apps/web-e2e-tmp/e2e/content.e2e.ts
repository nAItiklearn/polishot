import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const changelog = readFileSync(path.join(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8');

test.describe('home', () => {
  test('leads with a before and after, then one section per feature', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Screenshots, finished in about two seconds.');
    await expect(page.getByText('After, about two seconds later')).toBeVisible();

    for (const heading of [
      'Framed evenly, without a crop tool.',
      'Sensitive details, covered before you share.',
      'Nothing leaves your machine.',
      'The words in your screenshot, ready to paste.',
      'Sized for where it is going.',
      'Between your phone and PC, over your own Wi-Fi.',
      'Free, with every feature. Pro is $11, once.',
    ]) {
      await expect(page.getByRole('heading', { level: 2, name: heading })).toBeAttached();
    }
    await expect(page.getByText('Redaction runs on your machine. Nothing is uploaded.')).toBeAttached();
  });

  test('shows a neutral placeholder for every shot that has no file yet, never a broken image', async ({
    page,
  }) => {
    await page.goto('/');
    const names = await page.locator('[data-shot-placeholder]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-shot-placeholder')),
    );
    const images = await page.locator('main img').count();
    // Seven shots in total across the page, each either a placeholder or a real image.
    expect(names.length + images).toBe(7);
    await expect(page.locator('main img[src*="/shots/"]')).toHaveCount(images);
  });
});

test.describe('features', () => {
  test('lists every feature in a definition list, not as cards', async ({ page }) => {
    await page.goto('/features');
    const terms = await page.locator('dl dt').allInnerTexts();
    const flat = terms.join('\n');
    for (const feature of [
      'Global shortcut',
      'Window capture',
      'Scrolling capture',
      'GIF capture',
      'Open from file, clipboard or drag and drop',
      'Pin to screen',
      'Auto-balance',
      'Auto background',
      'Mockup frames',
      'Annotation tools',
      'Auto-redact',
      'Copy text',
      'History',
      'Social presets',
      'Export formats',
      'Quick send',
      'Batch',
      'No watermark',
      'Your own brand mark',
      'No limits',
      'A year of updates',
    ]) {
      expect(flat, `"${feature}" is listed`).toContain(feature);
    }
    await expect(page.locator('main svg')).toHaveCount(0); // no icon grid
  });

  test('the group links jump to their sections', async ({ page }) => {
    await page.goto('/features');
    await page.getByRole('navigation', { name: 'Feature groups' }).getByRole('link', { name: 'Protect' }).click();
    await expect(page).toHaveURL('/features#protect');
    await expect(page.getByRole('heading', { level: 2, name: 'Protect' })).toBeInViewport();
  });
});

test.describe('changelog', () => {
  test('is rendered from CHANGELOG.md at build time', async ({ page }) => {
    const bullets = changelog.split('\n').filter((l) => /^- /.test(l)).length;
    expect(bullets).toBeGreaterThan(0);

    await page.goto('/changelog');
    await expect(page.getByRole('heading', { level: 2, name: '0.1.0' })).toBeVisible();
    await expect(page.getByText('Unreleased', { exact: true })).toBeVisible();
    await expect(page.locator('.prose-ps li')).toHaveCount(bullets);
    // Inline code and escaping: the changelog text appears as text.
    await expect(page.getByText('Quick send between a PC and a phone')).toBeVisible();
  });
});

test.describe('legal pages', () => {
  for (const [route, heading] of [
    ['/privacy', 'Your screenshots stay on your device.'],
    ['/terms', 'The terms, in plain words.'],
  ] as const) {
    test(`${route} is marked as a template pending legal review`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.getByRole('note')).toContainText('has not been reviewed by a lawyer');
    });
  }

  test('privacy states the specifics of this product', async ({ page }) => {
    await page.goto('/privacy');
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    for (const phrase of [
      'not uploaded to us or to anyone else',
      'There is no account',
      'send no telemetry by default',
      'No tracking cookies',
      'local network',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });
});
