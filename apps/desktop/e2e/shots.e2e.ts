import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(OUT, { recursive: true });

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`) });

/** Opens the mock app and waits until the first capture is on screen and recognised. */
async function openReady(page: Page, query: string) {
  await page.goto(`/?mock=1&${query}`);
  await expect(page.locator('.pv-inspector')).toBeVisible();
  await expect(page.locator('.pe-canvas canvas').first()).toBeVisible();
  await expect(page.locator('.pv-found')).toBeVisible(); // OCR finished and found sensitive data
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });
    const q = `theme=${theme}&backdrop=mica`;

    test('empty state', async ({ page }) => {
      await page.goto(`/?mock=1&${q}&capture=0`);
      await expect(page.locator('.pv-empty')).toBeVisible();
      await shot(page, `01-empty-${theme}`);
    });

    test('preview: style, redact, text, export', async ({ page }) => {
      await openReady(page, q);
      await shot(page, `02-preview-style-${theme}`);
      await page.getByRole('tab', { name: /^Redact/ }).click();
      await shot(page, `03-preview-redact-${theme}`);
      await page.getByRole('tab', { name: 'Text' }).click();
      await shot(page, `04-preview-text-${theme}`);
      await page.getByRole('tab', { name: 'Export' }).click();
      await shot(page, `05-preview-export-${theme}`);
    });

    test('command palette', async ({ page }) => {
      await openReady(page, q);
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      await shot(page, `06-palette-${theme}`);
      await page.keyboard.type('copy');
      await shot(page, `07-palette-filtered-${theme}`);
    });

    test('history', async ({ page }) => {
      await openReady(page, q);
      await page.keyboard.press('Control+h');
      await expect(page.locator('.pv-hgrid').first()).toBeVisible();
      await expect(page.locator('.pv-hthumb img').first()).toBeVisible();
      await shot(page, `08-history-${theme}`);
      await page.getByRole('searchbox').fill('deploy');
      await expect(page.locator('.pv-hcard')).toHaveCount(1);
      await shot(page, `09-history-search-${theme}`);
      await page.getByRole('searchbox').fill('zzz');
      await expect(page.getByText('Nothing matches')).toBeVisible();
      await shot(page, `10-history-empty-search-${theme}`);
      await page.getByRole('button', { name: 'Clear all' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await shot(page, `11-history-confirm-${theme}`);
    });

    test('settings', async ({ page }) => {
      await openReady(page, q);
      await page.keyboard.press('Control+,');
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await shot(page, `12-settings-${theme}`);
      // Scroll to the lower groups.
      await page.locator('.pv-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await shot(page, `13-settings-lower-${theme}`);
    });

    test('settings (Pro): brand mark, and a toast', async ({ page }) => {
      await page.goto(`/?mock=1&${q}&lic=pro&warn=1`);
      await expect(page.locator('.pv-inspector')).toBeVisible();
      await expect(page.locator('.pv-toast')).toBeVisible(); // the startup shortcut warning
      await shot(page, `17-toast-warning-${theme}`);
      await page.keyboard.press('Control+,');
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await page.getByRole('radio', { name: 'Text' }).click();
      await page.getByRole('textbox', { name: 'Text', exact: true }).fill('maya.dev');
      await page.keyboard.press('Enter');
      await page.locator('.pv-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await shot(page, `18-settings-pro-brand-${theme}`);
      await page.keyboard.press('Escape'); // leaves the text field
      await page.keyboard.press('Escape'); // leaves Settings
      await expect(page.locator('.pv-inspector')).toBeVisible();
      await page.getByRole('tab', { name: 'Export' }).click();
      await shot(page, `19-export-pro-${theme}`);
    });

    test('license: free, pro, updates ended', async ({ page }) => {
      await openReady(page, q);
      await page.getByRole('button', { name: /License: Free/ }).click();
      await expect(page.getByRole('heading', { name: 'License' })).toBeVisible();
      await shot(page, `14-license-free-${theme}`);

      // No capture arrives in these two, so nothing can navigate back to the editor while the screen is being shown.
      await page.goto(`/?mock=1&${q}&lic=pro&capture=0`);
      await page.getByRole('button', { name: /License: Pro/ }).click();
      await expect(page.locator('.pv-facts')).toBeVisible();
      await shot(page, `15-license-pro-${theme}`);

      await page.goto(`/?mock=1&${q}&lic=expired&capture=0`);
      await page.getByRole('button', { name: /License: Free/ }).click();
      await expect(page.locator('.pv-license-notice')).toBeVisible();
      await shot(page, `16-license-expired-${theme}`);
    });
  });
}
