# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: shots.e2e.ts >> light theme >> history
- Location: e2e\shots.e2e.ts:50:5

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.fill: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('searchbox')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - generic [ref=e5]: Polishot
    - button "Open command palette" [ref=e7] [cursor=pointer]:
      - generic [ref=e10]: Search commands
      - generic [ref=e11]:
        - generic [ref=e12]: Ctrl
        - generic [ref=e13]: K
    - generic [ref=e14]:
      - button "History" [pressed] [ref=e15] [cursor=pointer]:
        - generic [aria-hidden]:
          - text: History
          - generic:
            - generic: Ctrl
            - generic: H
      - button "Settings" [ref=e19] [cursor=pointer]:
        - generic [aria-hidden]:
          - text: Settings
          - generic:
            - generic: Ctrl
            - generic: ","
      - 'button "License: Free. Open license." [ref=e23] [cursor=pointer]': Free
    - generic [ref=e24]:
      - button "Minimize" [ref=e25]
      - button "Maximize" [ref=e27]
      - button "Close to tray" [ref=e30]
  - main [ref=e33]:
    - generic [ref=e34]:
      - generic [ref=e35]:
        - button "Back to the editor" [ref=e36] [cursor=pointer]:
          - generic [aria-hidden]:
            - text: Back to the editor
            - generic: Esc
        - heading "History" [level=1] [ref=e39]
        - generic [ref=e40]:
          - searchbox "Search the text in your captures" [active] [ref=e45]: deploy
          - button "Clear all" [ref=e46] [cursor=pointer]
      - list "Captures" [ref=e48]:
        - listitem [ref=e49]:
          - button "Open the capture from Yesterday, 11:31 PM, 1600 × 900" [ref=e50] [cursor=pointer]:
            - generic [ref=e52]:
              - generic [ref=e53]: Yesterday, 11:31 PM
              - generic [ref=e54]: 1600 × 900
            - generic [ref=e55]: Deploy succeeded production api-gateway 42 seconds ago
          - button "Delete the capture from Yesterday, 11:31 PM" [ref=e56] [cursor=pointer]:
            - generic [aria-hidden]: Delete the capture from Yesterday, 11:31 PM
  - region "Notifications"
```

# Test source

```ts
  1   | import { expect, test, type Page } from '@playwright/test';
  2   | import { mkdirSync } from 'node:fs';
  3   | import { dirname, join } from 'node:path';
  4   | import { fileURLToPath } from 'node:url';
  5   | 
  6   | const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
  7   | mkdirSync(OUT, { recursive: true });
  8   | 
  9   | const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`) });
  10  | 
  11  | /** Opens the mock app and waits until the first capture is on screen and recognised. */
  12  | async function openReady(page: Page, query: string) {
  13  |   await page.goto(`/?mock=1&${query}`);
  14  |   await expect(page.locator('.pv-inspector')).toBeVisible();
  15  |   await expect(page.locator('.pe-canvas canvas').first()).toBeVisible();
  16  |   await expect(page.locator('.pv-found')).toBeVisible(); // OCR finished and found sensitive data
  17  | }
  18  | 
  19  | for (const theme of ['light', 'dark'] as const) {
  20  |   test.describe(`${theme} theme`, () => {
  21  |     test.use({ colorScheme: theme });
  22  |     const q = `theme=${theme}&backdrop=mica`;
  23  | 
  24  |     test('empty state', async ({ page }) => {
  25  |       await page.goto(`/?mock=1&${q}&capture=0`);
  26  |       await expect(page.locator('.pv-empty')).toBeVisible();
  27  |       await shot(page, `01-empty-${theme}`);
  28  |     });
  29  | 
  30  |     test('preview: style, redact, text, export', async ({ page }) => {
  31  |       await openReady(page, q);
  32  |       await shot(page, `02-preview-style-${theme}`);
  33  |       await page.getByRole('tab', { name: /^Redact/ }).click();
  34  |       await shot(page, `03-preview-redact-${theme}`);
  35  |       await page.getByRole('tab', { name: 'Text' }).click();
  36  |       await shot(page, `04-preview-text-${theme}`);
  37  |       await page.getByRole('tab', { name: 'Export' }).click();
  38  |       await shot(page, `05-preview-export-${theme}`);
  39  |     });
  40  | 
  41  |     test('command palette', async ({ page }) => {
  42  |       await openReady(page, q);
  43  |       await page.keyboard.press('Control+k');
  44  |       await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  45  |       await shot(page, `06-palette-${theme}`);
  46  |       await page.keyboard.type('copy');
  47  |       await shot(page, `07-palette-filtered-${theme}`);
  48  |     });
  49  | 
  50  |     test('history', async ({ page }) => {
  51  |       await openReady(page, q);
  52  |       await page.keyboard.press('Control+h');
  53  |       await expect(page.locator('.pv-hgrid')).toBeVisible();
  54  |       await expect(page.locator('.pv-hthumb img').first()).toBeVisible();
  55  |       await shot(page, `08-history-${theme}`);
  56  |       await page.getByRole('searchbox').fill('deploy');
  57  |       await expect(page.locator('.pv-hcard')).toHaveCount(1);
  58  |       await shot(page, `09-history-search-${theme}`);
> 59  |       await page.getByRole('searchbox').fill('zzz');
      |                                         ^ Error: locator.fill: Test timeout of 60000ms exceeded.
  60  |       await expect(page.getByText('Nothing matches')).toBeVisible();
  61  |       await shot(page, `10-history-empty-search-${theme}`);
  62  |       await page.getByRole('button', { name: 'Clear all' }).click();
  63  |       await expect(page.getByRole('alertdialog')).toBeVisible();
  64  |       await shot(page, `11-history-confirm-${theme}`);
  65  |     });
  66  | 
  67  |     test('settings', async ({ page }) => {
  68  |       await openReady(page, q);
  69  |       await page.keyboard.press('Control+,');
  70  |       await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  71  |       await shot(page, `12-settings-${theme}`);
  72  |       // Scroll to the lower groups.
  73  |       await page.locator('.pv-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  74  |       await shot(page, `13-settings-lower-${theme}`);
  75  |     });
  76  | 
  77  |     test('settings (Pro): brand mark, and a toast', async ({ page }) => {
  78  |       await page.goto(`/?mock=1&${q}&lic=pro&warn=1`);
  79  |       await expect(page.locator('.pv-inspector')).toBeVisible();
  80  |       await expect(page.locator('.pv-toast')).toBeVisible(); // the startup shortcut warning
  81  |       await shot(page, `17-toast-warning-${theme}`);
  82  |       await page.keyboard.press('Control+,');
  83  |       await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  84  |       await page.getByRole('radio', { name: 'Text' }).click();
  85  |       await page.getByLabel('Text', { exact: true }).fill('maya.dev');
  86  |       await page.keyboard.press('Enter');
  87  |       await page.locator('.pv-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  88  |       await shot(page, `18-settings-pro-brand-${theme}`);
  89  |       await page.keyboard.press('Escape'); // leaves the text field
  90  |       await page.keyboard.press('Escape'); // leaves Settings
  91  |       await expect(page.locator('.pv-inspector')).toBeVisible();
  92  |       await page.getByRole('tab', { name: 'Export' }).click();
  93  |       await shot(page, `19-export-pro-${theme}`);
  94  |     });
  95  | 
  96  |     test('license: free, pro, updates ended', async ({ page }) => {
  97  |       await openReady(page, q);
  98  |       await page.getByRole('button', { name: /License: Free/ }).click();
  99  |       await expect(page.getByRole('heading', { name: 'License' })).toBeVisible();
  100 |       await shot(page, `14-license-free-${theme}`);
  101 | 
  102 |       await page.goto(`/?mock=1&${q}&lic=pro`);
  103 |       await page.getByRole('button', { name: /License: Pro/ }).click();
  104 |       await expect(page.locator('.pv-facts')).toBeVisible();
  105 |       await shot(page, `15-license-pro-${theme}`);
  106 | 
  107 |       await page.goto(`/?mock=1&${q}&lic=expired`);
  108 |       await page.getByRole('button', { name: /License: Free/ }).click();
  109 |       await expect(page.locator('.pv-license-notice')).toBeVisible();
  110 |       await shot(page, `16-license-expired-${theme}`);
  111 |     });
  112 |   });
  113 | }
  114 | 
```