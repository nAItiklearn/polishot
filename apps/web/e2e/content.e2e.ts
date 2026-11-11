import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { PAGES } from './pages';

const changelog = readFileSync(path.join(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8');

test.describe('home', () => {
  test('leads with the name and the promise, then a live demo and one section per idea', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Polishot private by default.',
    );
    // The hero demo is built in HTML and every step can be chosen.
    const steps = page.getByRole('list', { name: 'Demo steps' }).getByRole('button');
    await expect(steps).toHaveCount(5);
    await steps.nth(2).click();
    await expect(steps.nth(2)).toHaveAttribute('aria-current', 'step');

    for (const heading of [
      'Everything a screenshot should do.',
      'Sensitive details, covered before you share.',
      'Your screenshots stay yours.',
      'From your phone to your PC, over your own Wi-Fi.',
      'The words in your screenshot, ready to paste.',
      'Framed evenly, sized for where it is going.',
      'Free, with every feature. Pro is $11, once.',
    ]) {
      await expect(page.getByRole('heading', { level: 2, name: heading })).toBeAttached();
    }
    await expect(
      page.getByText('Redaction runs on your machine. Nothing is uploaded.'),
    ).toBeAttached();
  });

  test('leads with privacy, in this order: redact, privacy, phone to PC', async ({ page }) => {
    await page.goto('/');
    const headings = await page.getByRole('heading', { level: 2 }).allInnerTexts();
    const at = (text: string) => headings.findIndex((h) => h.includes(text));
    expect(at('Sensitive details')).toBeGreaterThanOrEqual(0);
    expect(at('Sensitive details')).toBeLessThan(at('Your screenshots stay yours.'));
    expect(at('Your screenshots stay yours.')).toBeLessThan(at('From your phone to your PC'));
    expect(at('From your phone to your PC')).toBeLessThan(at('Framed evenly'));
  });

  test('the Share-safe check is labelled as coming in v0.2, never as shipping', async ({
    page,
  }) => {
    await page.goto('/');
    const note = page.getByTestId('soon-note');
    await expect(note).toHaveCount(1);
    await expect(note).toContainText('Coming in v0.2');
    await expect(note).toContainText('Share-safe check');
    // The note is the only place the home page mentions it.
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    expect(text.match(/Share-safe/g)).toHaveLength(1);
  });

  test('the redaction demo can show and cover each finding', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /^Email address/ });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toContainText('Covered');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toContainText('Shown');
  });

  test('uses no screenshots as images: the demos are live HTML', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main img[src*="/shots/"]')).toHaveCount(0);
    await expect(page.locator('main [data-demo]').first()).toBeAttached();
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

  test('the Share-safe check is listed, labelled as coming in v0.2', async ({ page }) => {
    await page.goto('/features');
    const item = page.locator('#share-safe');
    await expect(item.locator('dt')).toContainText('Share-safe check');
    await expect(item.getByTestId('soon-label')).toHaveText('Coming in v0.2');
    await expect(item.locator('dd')).toContainText('not in the current version');
    // Nothing else on the page is marked as unreleased.
    await expect(page.getByTestId('soon-label')).toHaveCount(1);
  });

  test('the group links jump to their sections', async ({ page }) => {
    await page.goto('/features');
    await page
      .getByRole('navigation', { name: 'Feature groups' })
      .getByRole('link', { name: 'Protect' })
      .click();
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
      'collect no analytics of their own',
      'never sends your images or the text in them',
      'No tracking cookies',
      'local network',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });
});

test.describe('positioning', () => {
  // Owner rule: competitors are never named on the site.
  const COMPETITORS = [
    'cleanshot',
    'snagit',
    'sharex',
    'lightshot',
    'greenshot',
    'shottr',
    'monosnap',
    'skitch',
    'flameshot',
    'snipping tool',
    'snip & sketch',
    'screenpresso',
  ];

  test('no page names a competitor, in its text or its metadata', async ({ page }) => {
    for (const { path } of PAGES) {
      await page.goto(path);
      const html = (await page.content()).toLowerCase();
      for (const name of COMPETITORS) {
        expect(html, `${path} mentions "${name}"`).not.toContain(name);
      }
    }
  });

  test('says what it is on every page: Windows and Android, and the price once', async ({
    page,
  }) => {
    await page.goto('/');
    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description).toContain('Windows and Android');
    expect(description).toContain('on your own device');
    expect(description).toContain('Pro is $11, once');
    await expect(page).toHaveTitle('Polishot | Polished screenshots, private by default.');
  });
});
