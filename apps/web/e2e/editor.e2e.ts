import AxeBuilder from '@axe-core/playwright';
import { expect as baseExpect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * The web editor, end to end, against the production build: nothing is uploaded, the editor code loads
 * only on /editor, text recognition runs on-device from self-hosted files, and every flow works with
 * keyboard and pointer.
 */

// Assertions poll for up to 15 s (the default is 5 s) so a busy machine does not turn into a flaky run.
const expect = baseExpect.configure({ timeout: 15_000 });

// Rendering a 4 MP canvas and running OCR are slow on a busy machine: allow time, never relax an assertion.
test.describe.configure({ timeout: 90_000 });

const EMAIL = 'alex.morgan@example.com';
const CARD = '4242 4242 4242 4242';

// A valid 1x1 PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A crisp, large-type screenshot with a known email and card number, drawn in the browser. */
async function makeFixture(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(
    ({ email, card }) => {
      const c = document.createElement('canvas');
      c.width = 1500;
      c.height = 460;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#111111';
      g.textBaseline = 'alphabetic';
      g.font = '700 60px Arial, Helvetica, sans-serif';
      g.fillText('Billing contact', 70, 120);
      g.font = '400 60px Arial, Helvetica, sans-serif';
      g.fillText(email, 70, 245);
      g.fillText(`Card ${card}`, 70, 370);
      return c.toDataURL('image/png').split(',')[1]!;
    },
    { email: EMAIL, card: CARD },
  );
  return Buffer.from(b64, 'base64');
}

const png = (name: string, buffer: Buffer) => ({ name, mimeType: 'image/png', buffer });

function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const studio = (page: Page) => page.getByTestId('editor-studio');
const notice = (page: Page) => page.getByTestId('editor-notice');

async function openSample(page: Page) {
  await page.goto('/editor');
  await page.getByRole('button', { name: 'Try the sample' }).click();
  await expect(studio(page)).toBeVisible();
  await expect(page.locator('.pe-root canvas').first()).toBeVisible();
}

async function openFixture(page: Page, name = 'fixture.png') {
  await page.goto('/editor');
  await page.getByRole('button', { name: 'Try the sample' }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(png(name, await makeFixture(page)));
  await expect(studio(page)).toBeVisible();
}

/** Watches the page: nothing may leave the browser, and nothing may throw. */
function watch(page: Page, baseURL: string) {
  const foreign: string[] = [];
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (!url.startsWith(baseURL)) foreign.push(url);
    if (req.method() !== 'GET' && req.method() !== 'HEAD') writes.push(`${req.method()} ${url}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return { foreign, writes, errors };
}

test.describe('editor shell', () => {
  test('is client-only: the server HTML carries no editor UI', async ({ request }) => {
    const html = await (await request.get('/editor')).text();
    for (const marker of ['Annotation tools', 'pe-toolbar', 'Choose image', 'Try the sample', 'konva']) {
      expect(html, marker).not.toContain(marker);
    }
  });

  test('marketing pages never load the editor or the OCR engine', async ({ page }) => {
    const scripts: string[] = [];
    page.on('response', async (res) => {
      if (res.request().resourceType() === 'script') {
        const body = await res.text().catch(() => '');
        if (/Konva|tesseract/i.test(body)) scripts.push(res.url());
      }
    });
    for (const path of ['/', '/features', '/pricing', '/download']) {
      await page.goto(path);
      await page.waitForLoadState('load');
      await page.waitForTimeout(1500);
    }
    expect(scripts).toEqual([]);
  });

  test('shows the empty state with one plain privacy line, and loads nothing heavy until asked', async ({ page }) => {
    const loaded: string[] = [];
    page.on('request', (r) => loaded.push(r.url()));
    await page.goto('/editor');
    await expect(page.getByRole('heading', { name: 'Drop a screenshot' })).toBeVisible();
    await expect(page.getByText('Runs in your browser. Nothing is uploaded.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose image' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try the sample' })).toBeVisible();
    expect(loaded.filter((u) => u.includes('/ocr/'))).toEqual([]);
  });
});

test.describe('editing', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'Pointer and keyboard editing is checked on desktop; mobile has its own spec below.');
  });

  test('the sample opens already styled: auto-balance applied, nothing uploaded', async ({ page, baseURL }) => {
    const seen = watch(page, baseURL!);
    await openSample(page);

    const padding = Number(await studio(page).getAttribute('data-padding'));
    expect(padding).toBeGreaterThan(0);
    await expect(page.getByText('sample-billing.png')).toBeVisible();
    await expect(page.locator('.ed-file-dims')).toHaveText('2560 × 1600');
    // The free tier always exports with the watermark: the website has no licence activation.
    await page.getByRole('tab', { name: 'Export' }).click();
    await expect(page.getByText('Free exports include a small watermark.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Remove it with Pro' })).toHaveAttribute('href', '/pricing');

    expect(seen.foreign, 'requests to other origins').toEqual([]);
    expect(seen.writes, 'requests that send data').toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('opens a PNG from the file input and replaces it with another', async ({ page, baseURL }) => {
    const seen = watch(page, baseURL!);
    await page.goto('/editor');
    await page.getByRole('button', { name: 'Try the sample' }).waitFor();
    await page.locator('input[type="file"]').setInputFiles(png('shot.png', TINY_PNG));
    await expect(studio(page)).toBeVisible();
    await expect(page.getByText('shot.png')).toBeVisible();
    await expect(page.locator('.ed-file-dims')).toHaveText('1 × 1');

    await page.locator('input[type="file"]').setInputFiles(png('second.png', await makeFixture(page)));
    await expect(page.getByText('second.png')).toBeVisible();
    await expect(page.locator('.ed-file-dims')).toHaveText('1500 × 460');
    expect(seen.writes).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('refuses files that are not images, or too large, with a plain next step', async ({ page }) => {
    await page.goto('/editor');
    await page.getByRole('button', { name: 'Try the sample' }).waitFor();
    const input = page.locator('input[type="file"]');

    await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(notice(page)).toContainText('not a PNG, JPEG or WebP');
    await expect(page.getByRole('heading', { name: 'Drop a screenshot' })).toBeVisible();

    // Claims to be a PNG but is not.
    await input.setInputFiles(png('fake.png', Buffer.from('this is not an image at all')));
    await expect(notice(page)).toContainText('not a PNG, JPEG or WebP');

    const big = Buffer.alloc(26 * 1024 * 1024);
    TINY_PNG.copy(big);
    await input.setInputFiles(png('huge.png', big));
    await expect(notice(page)).toContainText('larger than 25 MB');
    await expect(page.getByRole('heading', { name: 'Drop a screenshot' })).toBeVisible();

    await notice(page).getByRole('button', { name: 'Dismiss message' }).click();
    await expect(notice(page)).toHaveAttribute('data-empty', 'true');
  });

  test('accepts a dropped image and a pasted image', async ({ page }) => {
    await page.goto('/editor');
    await page.getByRole('button', { name: 'Try the sample' }).waitFor();
    const b64 = TINY_PNG.toString('base64');
    const makeTransfer = (name: string) =>
      page.evaluateHandle(
        ([data, fileName]) => {
          const bytes = Uint8Array.from(atob(data!), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], fileName!, { type: 'image/png' }));
          return dt;
        },
        [b64, name] as const,
      );

    const app = page.getByTestId('editor-app');
    const dropped = await makeTransfer('dropped.png');
    await app.dispatchEvent('dragenter', { dataTransfer: dropped });
    await expect(app).toHaveAttribute('data-dragging', 'true');
    await app.dispatchEvent('drop', { dataTransfer: dropped });
    await expect(page.getByText('dropped.png')).toBeVisible();

    const pasted = await makeTransfer('pasted.png');
    await page.evaluate((dt) => {
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, pasted);
    await expect(page.getByText('pasted.png')).toBeVisible();
  });

  test('draws a rectangle, then undo and redo walk it back and forth', async ({ page }) => {
    await openSample(page);
    await expect(studio(page)).toHaveAttribute('data-annotations', '0');

    await page.keyboard.press('r');
    await expect(page.getByRole('button', { name: 'Rectangle' })).toHaveAttribute('aria-pressed', 'true');

    const box = (await page.locator('.pe-root').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx - 120, cy - 60);
    await page.mouse.down();
    await page.mouse.move(cx, cy, { steps: 6 });
    await page.mouse.move(cx + 120, cy + 60, { steps: 6 });
    await page.mouse.up();
    await expect(studio(page)).toHaveAttribute('data-annotations', '1');

    await page.keyboard.press('Control+z');
    await expect(studio(page)).toHaveAttribute('data-annotations', '0');
    await page.keyboard.press('Control+Shift+z');
    await expect(studio(page)).toHaveAttribute('data-annotations', '1');

    // The toolbar buttons do the same.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(studio(page)).toHaveAttribute('data-annotations', '0');
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(studio(page)).toHaveAttribute('data-annotations', '1');
  });

  test('keyboard only: tool shortcuts, Escape, and the panel tabs', async ({ page }) => {
    await openSample(page);
    const pressed = async (name: string) =>
      expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');

    for (const [key, name] of [
      ['a', 'Arrow'],
      ['e', 'Ellipse'],
      ['l', 'Line'],
      ['t', 'Text'],
      ['b', 'Blur'],
      ['n', 'Step'],
      ['v', 'Select'],
    ] as const) {
      await page.keyboard.press(key);
      await pressed(name);
    }
    await page.keyboard.press('r');
    await pressed('Rectangle');
    await page.keyboard.press('Escape');
    await pressed('Select');

    // Tabs: arrows move focus, Enter or Space opens one. Nothing heavy loads while browsing them.
    const ocrRequests: string[] = [];
    page.on('request', (r) => r.url().includes('/ocr/') && ocrRequests.push(r.url()));
    const style = page.getByRole('tab', { name: 'Style' });
    await style.focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Export' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Export' })).toBeVisible();
    expect(ocrRequests).toEqual([]);
  });

  test('finds an email and a card number on-device, blurs them, and copies all the text', async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    const seen = watch(page, baseURL!);
    const ocrRequests: string[] = [];
    page.on('request', (r) => r.url().includes('/ocr/') && ocrRequests.push(new URL(r.url()).pathname));
    await openFixture(page);

    // Opening the app and the sample must not have touched the OCR files.
    expect(ocrRequests).toEqual([]);

    await page.getByRole('tab', { name: 'Redact' }).click();
    const badge = page.getByTestId('found-badge');
    await expect(badge).toContainText('2', { timeout: 120_000 });
    expect(ocrRequests).toEqual(
      expect.arrayContaining(['/ocr/worker.min.js', '/ocr/tesseract-core-simd-lstm.wasm.js', '/ocr/eng.traineddata']),
    );

    const rows = page.getByRole('switch');
    await expect(rows).toHaveCount(2);
    await expect(page.getByRole('switch', { name: /email/i })).toBeVisible();
    await expect(page.getByRole('switch', { name: /card/i })).toBeVisible();
    await expect(page.getByText('2 found')).toBeVisible();

    await page.getByRole('button', { name: 'Blur all' }).click();
    await expect(studio(page)).toHaveAttribute('data-annotations', '2');
    await expect(page.getByText('2 of 2 hidden')).toBeVisible();

    // One undo takes the redactions off again.
    await page.keyboard.press('Control+z');
    await expect(studio(page)).toHaveAttribute('data-annotations', '0');
    await page.keyboard.press('Control+Shift+z');
    await expect(studio(page)).toHaveAttribute('data-annotations', '2');

    // The recognised text is selectable on the image and copyable in one click.
    await page.getByRole('tab', { name: 'Text' }).click();
    await expect(page.getByTestId('ocr-text')).toContainText(EMAIL);
    await page.getByRole('button', { name: 'Copy all text' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain(EMAIL);
    expect(clipboard).toContain(CARD);

    expect(seen.foreign, 'requests to other origins').toEqual([]);
    expect(seen.writes, 'requests that send data').toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('"Find text" opens the Text panel and the canvas stays usable while it runs', async ({ page }) => {
    test.setTimeout(240_000);
    await openFixture(page);
    await page.getByRole('button', { name: 'Find text' }).click();
    await expect(page.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true');
    // Not blocked: tools still switch while recognition runs or after it finishes.
    await page.keyboard.press('e');
    await expect(page.getByRole('button', { name: 'Ellipse' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('ocr-text')).toContainText(EMAIL, { timeout: 120_000 });
    await expect(page.getByTestId('word-count')).toContainText('words');
  });

  test('exports a PNG at the size it promises, at 1x and 2x, and JPEG as a .jpg', async ({ page }) => {
    await openSample(page);
    await page.getByRole('tab', { name: 'Export' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Export' });
    const sizeOf = async () => {
      const text = (await page.getByTestId('export-size').textContent()) ?? '';
      const m = /(\d+)×(\d+)/.exec(text);
      expect(m, text).not.toBeNull();
      return { width: Number(m![1]), height: Number(m![2]) };
    };

    for (const scale of [1, 2] as const) {
      await panel.getByRole('button', { name: `Scale ${scale}x` }).click();
      const promised = await sizeOf();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        panel.getByRole('button', { name: 'Download' }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^polishot-\d{8}-\d{6}\.png$/);
      const file = await download.path();
      const actual = pngSize(await readFile(file));
      expect(actual).toEqual(promised);
      await expect(notice(page)).toContainText(`Saved ${promised.width} × ${promised.height} PNG`);
    }

    await panel.getByRole('button', { name: 'JPEG' }).click();
    await expect(panel.getByLabel('Quality')).toBeVisible();
    const [jpg] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Download' }).click()]);
    expect(jpg.suggestedFilename()).toMatch(/\.jpg$/);
    const head = (await readFile(await jpg.path())).subarray(0, 3);
    expect([...head]).toEqual([0xff, 0xd8, 0xff]);
  });

  test('Ctrl+C copies the styled image and says so', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSample(page);
    await page.keyboard.press('Control+c');
    await expect(notice(page)).toContainText('Copied', { timeout: 15_000 });
    const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types));
    expect(types).toContain('image/png');

    // The primary button does the same.
    await page.keyboard.press('Escape');
    await notice(page).getByRole('button', { name: 'Dismiss message' }).click();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(notice(page)).toContainText('Copied', { timeout: 15_000 });
  });
});

test.describe('accessibility', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'Axe runs on the desktop layout; the mobile layout has its own check below.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe finds no violations in the ${scheme} theme, empty and with an image`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.addInitScript((t) => localStorage.setItem('ps-theme', t), scheme);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/editor');
      await page.getByRole('button', { name: 'Try the sample' }).waitFor();
      await page.waitForTimeout(300);

      const scan = async () => {
        await page.evaluate(() => document.fonts.ready);
        const { violations } = await new AxeBuilder({ page }).analyze();
        return violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 4) }));
      };

      let violations = await scan();
      expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'), 'empty state').toEqual([]);
      expect(violations, 'empty state, any impact').toEqual([]);

      await page.getByRole('button', { name: 'Try the sample' }).click();
      await expect(studio(page)).toBeVisible();
      for (const tab of ['Style', 'Redact', 'Text', 'Export']) {
        if (tab === 'Redact' || tab === 'Text') {
          // Open without waiting for the engine: the panel markup is what is under test.
          await page.getByRole('tab', { name: tab }).click();
          await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
        } else {
          await page.getByRole('tab', { name: tab }).click();
        }
        violations = await scan();
        expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'), `${tab} tab`).toEqual([]);
        expect(violations, `${tab} tab, any impact`).toEqual([]);
      }
    });
  }
});

test.describe('phones and tablets', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, 'Mobile layout only.');
  });

  test('the sample opens with a bottom sheet that opens, switches and collapses', async ({ page }) => {
    await openSample(page);
    const side = page.locator('.ed-side');
    await expect(side).toHaveAttribute('data-open', 'false');
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await expect(page.getByText('sample-billing.png')).toBeVisible();

    // The canvas is the hero: it keeps most of the screen while the sheet is closed.
    const viewport = page.viewportSize()!;
    const canvas = (await page.locator('.pe-canvas').boundingBox())!;
    expect(canvas.height).toBeGreaterThan(viewport.height * 0.5);

    await page.getByRole('tab', { name: 'Style' }).click();
    await expect(side).toHaveAttribute('data-open', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Style' })).toBeVisible();

    await page.getByRole('tab', { name: 'Export' }).click();
    await expect(page.getByTestId('export-size')).toBeVisible();

    await page.getByRole('button', { name: 'Hide panel' }).click();
    await expect(side).toHaveAttribute('data-open', 'false');
    await expect(page.getByRole('tabpanel', { name: 'Export' })).toBeHidden();

    // No horizontal scroll on the page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('has no serious accessibility violations with the sheet open', async ({ page }) => {
    await openSample(page);
    await page.getByRole('tab', { name: 'Style' }).click();
    await page.waitForTimeout(300);
    const { violations } = await new AxeBuilder({ page }).analyze();
    const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(blocking, JSON.stringify(blocking.map((v) => [v.id, v.nodes.map((n) => n.target.join(' '))]))).toEqual([]);
  });
});
