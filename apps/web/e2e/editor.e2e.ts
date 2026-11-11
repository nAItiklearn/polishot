import AxeBuilder from '@axe-core/playwright';
import { expect as baseExpect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { headerSize, sniffKind } from '../app/editor/image';
import { ocrScaleFor, wordsFromBlocks } from '../app/editor/ocr';

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

  test('only /editor may run WebAssembly and blob workers; the CSP names no remote origin anywhere', async ({ request }) => {
    const csp = async (path: string) => (await request.get(path)).headers()['content-security-policy'] ?? '';
    const editor = await csp('/editor');
    expect(editor).toContain("worker-src 'self' blob:");
    expect(editor).toContain("'wasm-unsafe-eval'");
    expect(editor).not.toMatch(/https?:\/\//);
    expect(editor).toContain("connect-src 'self'");
    for (const path of ['/', '/features', '/pricing', '/download']) {
      const other = await csp(path);
      expect(other, path).toContain("worker-src 'none'");
      expect(other, path).not.toContain('wasm-unsafe-eval');
    }
  });

  // A Content-Security-Policy belongs to the document the browser loaded. Reaching /editor through an in-app link
  // keeps the previous page's stricter policy, which blocks the text engine, so the editor loads itself fresh.
  const BLOB_WORKER_ALLOWED = () =>
    new Promise<boolean>((resolve) => {
      try {
        const worker = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
        worker.onmessage = () => {
          worker.terminate();
          resolve(true);
        };
        worker.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  const inAppNavigation = (path: string) => (window as unknown as { next: { router: { push: (p: string) => void } } }).next.router.push(path);

  test('arriving from another page through an in-app link loads /editor fresh, so its own policy applies', async ({ page }) => {
    await page.goto('/pricing');
    expect(await page.evaluate(BLOB_WORKER_ALLOWED), 'other pages do not allow blob workers').toBe(false);
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    await page.evaluate(inAppNavigation, '/editor');
    // The marker lives on the old document: it is gone only if the page was loaded again.
    await page.waitForFunction(
      () => location.pathname === '/editor' && (window as unknown as { __marker?: number }).__marker === undefined,
    );
    await expect(page.getByRole('heading', { name: 'Drop a screenshot' })).toBeVisible();
    expect(await page.evaluate(BLOB_WORKER_ALLOWED), 'the editor document allows the engine').toBe(true);
  });

  test('never reloads in a loop; if the engine is still blocked it says so and offers a reload', async ({ page }) => {
    await page.goto('/pricing');
    await page.evaluate(() => {
      // A reload "happened" just now (dated in the future so a slow machine cannot outlast the 30 s guard).
      sessionStorage.setItem('polishot.editor.reloaded', String(Date.now() + 600_000));
      (window as unknown as { __marker: number }).__marker = 1;
    });
    await page.evaluate(inAppNavigation, '/editor');
    await page.getByRole('button', { name: 'Try the sample' }).click();
    await expect(studio(page)).toBeVisible();
    await page.getByRole('tab', { name: 'Text' }).click();
    // Edits on the canvas are never thrown away: the message stays, with a button.
    const alert = page.getByRole('alert').filter({ hasText: 'blocked text recognition' });
    await expect(alert).toBeVisible({ timeout: 60_000 });
    await expect(alert.getByRole('button', { name: 'Reload page' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker), 'no reload happened').toBe(1);

    // The button loads the page fresh, and the engine is allowed there.
    await alert.getByRole('button', { name: 'Reload page' }).click();
    await page.waitForFunction(() => (window as unknown as { __marker?: number }).__marker === undefined);
    await expect(page.getByRole('heading', { name: 'Drop a screenshot' })).toBeVisible();
    expect(await page.evaluate(BLOB_WORKER_ALLOWED)).toBe(true);
  });

  test('the text engine files are cached by the browser for a month', async ({ request }) => {
    for (const name of ['worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'eng.traineddata']) {
      const res = await request.head(`/ocr/${name}`);
      expect(res.status(), name).toBe(200);
      expect(res.headers()['cache-control'], name).toContain('max-age=2592000');
    }
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
    // Scoped to the toolbar: the Blur tool also shows a "Blur" mode button in the Style panel.
    const toolbar = page.getByRole('toolbar', { name: 'Annotation tools' });
    const pressed = async (name: string) =>
      expect(toolbar.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');

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

    // Tabs: arrows move focus, Enter or Space opens one. Browsing them opens nothing and starts no recognition.
    const style = page.getByRole('tab', { name: 'Style' });
    await style.focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Export' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Export' })).toBeVisible();
    for (const name of ['Redact', 'Text']) {
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false');
    }
    await expect(page.getByTestId('ocr-progress')).toHaveCount(0);
  });

  test('finds an email and a card number on-device, blurs them, and copies all the text', async ({ page, context, baseURL }) => {
    test.setTimeout(240_000);
    // Reading the clipboard back (to check what Copy all text put there) needs the browser permission.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const seen = watch(page, baseURL!);
    const ocrRequests: string[] = [];
    page.on('request', (r) => r.url().includes('/ocr/') && ocrRequests.push(new URL(r.url()).pathname));
    await openFixture(page);

    // The engine warms up in the background after an image opens (see the warm-up test), but nothing is read
    // until the Redact or Text panel is shown.
    await expect(page.getByTestId('ocr-progress')).toHaveCount(0);

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
    await expect(page.locator('#ed-panel-redact').getByText('2 found')).toBeVisible();

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

  test('warms the text engine in the background once an image is open, from this site only', async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    const seen = watch(page, baseURL!);
    const files = new Set<string>();
    page.on('response', (r) => {
      if (r.url().includes('/ocr/')) files.add(new URL(r.url()).pathname);
    });
    await page.goto('/editor');
    await page.getByRole('button', { name: 'Try the sample' }).waitFor();
    await page.waitForTimeout(1500);
    expect([...files], 'nothing is fetched while there is no image').toEqual([]);

    await page.getByRole('button', { name: 'Try the sample' }).click();
    await expect(studio(page)).toBeVisible();
    // Nobody clicked Redact or Text: the engine, its WebAssembly core and the language model arrive by themselves.
    await expect
      .poll(() => [...files].sort(), { timeout: 120_000 })
      .toEqual(['/ocr/eng.traineddata', '/ocr/tesseract-core-simd-lstm.wasm.js', '/ocr/worker.min.js']);
    await expect(page.getByTestId('ocr-progress')).toHaveCount(0);
    expect(seen.foreign, 'requests to other origins').toEqual([]);
    expect(seen.writes, 'requests that send data').toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('exports a PNG at the size it promises, at 1x and 2x, and JPEG as a .jpg', async ({ page }) => {
    // Three full-size renders in a row: allow for a busy machine, never relax an assertion.
    test.setTimeout(240_000);
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
      // The toast only stays for a few seconds, so read it before the slow part (waiting for the file).
      await expect(notice(page)).toContainText(`Saved ${promised.width} × ${promised.height} PNG`);
      const file = await download.path();
      const actual = pngSize(await readFile(file));
      expect(actual).toEqual(promised);
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

/** Everything on the canvas as one picture: two pictures are equal only if nothing on it moved. */
const canvasShot = (page: Page) => page.locator('.pe-canvas').screenshot({ animations: 'disabled' });

/** Facts about the document that the app mirrors onto the studio root (see Workspace.tsx). */
const lastOf = async (page: Page) => (await studio(page).getAttribute('data-last')) ?? '';
const numbers = (s: string) => s.split(':')[1]!.split(',').map(Number);
const stepsOf = async (page: Page) => (await studio(page).getAttribute('data-steps')) ?? '';
const paddingOf = async (page: Page) => Number(await studio(page).getAttribute('data-padding'));

test.describe('the interaction bar (docs/UX-BAR.md), end to end', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'Pointer and keyboard editing is checked on desktop.');
  });

  test('open, hover then click a background, drag padding, Shift arrow, two steps, delete one, redact, undo x3, redo, copy', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const seen = watch(page, baseURL!);
    await openFixture(page);
    const undo = page.getByRole('button', { name: 'Undo' });
    const box = (await page.locator('.pe-root').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const away = () => page.mouse.move(cx, box.y - 24);

    // 1. The capture opens already styled: nothing is committed, so there is nothing to undo.
    await expect(undo).toBeDisabled();
    await expect(studio(page)).toHaveAttribute('data-annotations', '0');
    const styled = await canvasShot(page);

    // 2. Hovering a background previews it without committing; leaving restores; a click commits.
    const swatch = page.getByRole('group', { name: 'Background' }).getByRole('button').nth(2);
    await swatch.hover();
    await expect.poll(async () => (await canvasShot(page)).equals(styled)).toBe(false);
    await expect(undo).toBeDisabled();
    await away();
    await expect.poll(async () => (await canvasShot(page)).equals(styled)).toBe(true);
    await swatch.click();
    await away();
    await expect(undo).toBeEnabled();
    await expect(swatch).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await canvasShot(page)).equals(styled)).toBe(false);

    // 3. A padding drag is live (the value moves while the pointer is still down) and is one undo step.
    const before = await paddingOf(page);
    const slider = page.getByLabel('Padding', { exact: true });
    const s = (await slider.boundingBox())!;
    await page.mouse.move(s.x + s.width * 0.3, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width * 0.6, s.y + s.height / 2, { steps: 8 });
    expect(await paddingOf(page), 'padding follows the pointer before it is released').not.toBe(before);
    await page.mouse.move(s.x + s.width * 0.8, s.y + s.height / 2, { steps: 8 });
    await page.mouse.up();
    const after = await paddingOf(page);
    expect(after).not.toBe(before);
    // The slider still has the focus, and Ctrl+C copies the image anyway (a slider is not a text field).
    await expect(slider).toBeFocused();
    await page.keyboard.press('Control+c');
    await expect(notice(page)).toContainText('Copied', { timeout: 30_000 });
    await notice(page).getByRole('button', { name: 'Dismiss message' }).click();
    await page.keyboard.press('Control+z');
    expect(await paddingOf(page), 'the whole drag undoes in one step').toBe(before);
    await page.keyboard.press('Control+Shift+z');
    expect(await paddingOf(page)).toBe(after);

    // 4. Shift constrains an arrow to a multiple of 45 degrees, and the tool stays on for the next shape.
    await page.keyboard.press('a');
    await page.mouse.move(cx - 150, cy - 90);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(cx, cy - 60, { steps: 5 });
    await page.mouse.move(cx + 120, cy + 40, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(studio(page)).toHaveAttribute('data-annotations', '1');
    const [x1, y1, x2, y2] = numbers(await lastOf(page));
    const dx = Math.abs(x2! - x1!);
    const dy = Math.abs(y2! - y1!);
    expect(dy <= 1 || dx <= 1 || Math.abs(dx - dy) <= 1, `arrow ${dx} x ${dy} is a multiple of 45 degrees`).toBe(true);
    await expect(studio(page)).toHaveAttribute('data-tool', 'arrow');

    // 5. Two numbered steps; deleting the first renumbers the second.
    await page.keyboard.press('n');
    const first = { x: cx - 200, y: cy + 70 };
    const second = { x: cx + 200, y: cy + 70 };
    await page.mouse.click(first.x, first.y);
    await page.mouse.click(second.x, second.y);
    expect(await stepsOf(page)).toBe('1,2');
    await page.keyboard.press('v');
    await page.mouse.click(first.x, first.y);
    await expect(studio(page)).toHaveAttribute('data-selected', 'step');
    await page.keyboard.press('Delete');
    expect(await stepsOf(page), 'the remaining step becomes 1').toBe('1');

    // 6. Sensitive data is found on this device and hidden in one click.
    await page.getByRole('tab', { name: 'Redact' }).click();
    await expect(page.getByTestId('found-badge')).toContainText('2', { timeout: 120_000 });
    const drawn = Number(await studio(page).getAttribute('data-annotations'));
    await page.getByRole('button', { name: 'Blur all' }).click();
    await expect(studio(page)).toHaveAttribute('data-annotations', String(drawn + 2));

    // 7. Undo three times: the redactions, the delete (with its renumbering), the second step.
    await page.keyboard.press('Control+z');
    await expect(studio(page)).toHaveAttribute('data-annotations', String(drawn));
    await page.keyboard.press('Control+z');
    expect(await stepsOf(page), 'undoing the delete restores both steps').toBe('1,2');
    await page.keyboard.press('Control+z');
    expect(await stepsOf(page)).toBe('1');

    // 8. Redo, then copy the finished image.
    await page.keyboard.press('Control+Shift+z');
    expect(await stepsOf(page)).toBe('1,2');
    await page.keyboard.press('Control+c');
    await expect(notice(page)).toContainText('Copied', { timeout: 15_000 });
    const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types));
    expect(types).toContain('image/png');

    expect(seen.foreign, 'requests to other origins').toEqual([]);
    expect(seen.writes, 'requests that send data').toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('arrow keys nudge a selection by 1 px and Shift+arrow by 10; Ctrl+D duplicates it in one undo step', async ({ page }) => {
    await openFixture(page);
    const box = (await page.locator('.pe-root').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.keyboard.press('r');
    await page.mouse.move(cx - 80, cy - 40);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 40, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('v');
    await expect(studio(page)).toHaveAttribute('data-annotations', '1');
    // A drawn shape is selected; if not, pick it by its edge.
    if ((await studio(page).getAttribute('data-selected')) !== 'rect') await page.mouse.click(cx, cy - 40);
    await expect(studio(page)).toHaveAttribute('data-selected', 'rect');

    const [x0, y0] = numbers(await lastOf(page));
    await page.keyboard.press('ArrowRight');
    const [x1, y1] = numbers(await lastOf(page));
    expect([x1! - x0!, y1! - y0!]).toEqual([1, 0]);
    await page.keyboard.press('Shift+ArrowDown');
    const [x2, y2] = numbers(await lastOf(page));
    expect([x2! - x1!, y2! - y1!]).toEqual([0, 10]);

    await page.keyboard.press('Control+d');
    await expect(studio(page)).toHaveAttribute('data-annotations', '2');
    await page.keyboard.press('Control+z');
    await expect(studio(page)).toHaveAttribute('data-annotations', '1');
  });
});

test.describe('saved looks: Free keeps three, in this browser only', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'Desktop layout.');
  });

  const looksOf = (page: Page) => page.getByRole('region', { name: 'Saved looks' });

  test('saves up to three, blocks the fourth, survives a reload, applies, deletes, and links to Pro in a new tab', async ({
    page,
    baseURL,
  }) => {
    const seen = watch(page, baseURL!);
    await openSample(page);
    const looks = looksOf(page);
    const swatches = page.getByRole('group', { name: 'Background' }).getByRole('button');
    const name = looks.getByLabel('Name for this look');

    const save = async (label: string, swatch: number) => {
      await swatches.nth(swatch).click();
      await name.fill(label);
      await looks.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(looks.getByRole('button', { name: label, exact: true })).toBeVisible();
    };
    await save('One', 1);
    await save('Two', 2);
    await save('Three', 3);
    await expect(looks.getByText('3 of 3')).toBeVisible();
    await expect(name).toBeDisabled();
    await expect(looks.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(looks.getByText('Free keeps 3 presets')).toBeVisible();

    // The Pro link opens pricing in a new tab, so the work in progress stays where it is.
    const [popup] = await Promise.all([page.waitForEvent('popup'), looks.getByRole('button', { name: 'See Pro' }).click()]);
    expect(new URL(popup.url()).pathname).toBe('/pricing');
    await popup.close();
    await expect(studio(page)).toBeVisible();

    // Nothing but this browser's storage was involved.
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('polishot.looks.v1') ?? '[]') as { name: string }[]);
    expect(stored.map((l) => l.name)).toEqual(['One', 'Two', 'Three']);

    // They are still there after a reload, and clicking one applies it.
    await page.reload();
    await page.getByRole('button', { name: 'Try the sample' }).click();
    await expect(studio(page)).toBeVisible();
    await looks.getByRole('button', { name: 'Two', exact: true }).click();
    await expect(swatches.nth(2)).toHaveAttribute('aria-pressed', 'true');
    await looks.getByRole('button', { name: 'One', exact: true }).click();
    await expect(swatches.nth(1)).toHaveAttribute('aria-pressed', 'true');

    // Deleting one frees a slot.
    await looks.getByRole('button', { name: 'Delete look Three' }).click();
    await expect(looks.getByText('2 of 3')).toBeVisible();
    await expect(name).toBeEnabled();

    expect(seen.foreign).toEqual([]);
    expect(seen.writes).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('ignores hostile or damaged storage, and never shows more than it should', async ({ page }) => {
    await page.addInitScript(() => {
      const ok = { padding: 0.1, background: { type: 'solid', color: '#224466' }, radius: 8, shadow: 0.3, frame: 'none', preset: 'auto' };
      localStorage.setItem(
        'polishot.looks.v1',
        JSON.stringify([
          { id: 'good', name: 'Kept', settings: ok },
          { id: 'bad id!', name: 'Bad id', settings: ok },
          { id: 'frame', name: 'Bad frame', settings: { ...ok, frame: 'toaster' } },
          { id: 'bg', name: 'Bad colour', settings: { ...ok, background: { type: 'solid', color: 'url(javascript:alert(1))' } } },
          { id: 'svg', name: 'SVG', settings: { ...ok, background: { type: 'image', src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', blur: 1 } } },
          { id: 'proto', name: 'Proto', settings: JSON.parse('{"__proto__":{"polluted":true},"padding":0.1}') },
          { id: 'good', name: 'Duplicate id', settings: ok },
          { id: 'noname', name: '   ', settings: ok },
          'not an object',
          null,
        ]),
      );
    });
    await openSample(page);
    const looks = looksOf(page);
    await expect(looks.getByRole('button', { name: 'Kept', exact: true })).toBeVisible();
    await expect(looks.getByText('1 of 3')).toBeVisible();
    await expect(looks.locator('.pe-look')).toHaveCount(1);
    expect(await page.evaluate(() => ({}.hasOwnProperty.call(Object.prototype, 'polluted'))), 'prototype untouched').toBe(false);
  });

  test('says so, and keeps working, when the browser blocks storage', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    });
    await openSample(page);
    const looks = looksOf(page);
    await looks.getByLabel('Name for this look').fill('Nope');
    await looks.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(notice(page)).toContainText('could not be saved');
    await expect(studio(page)).toBeVisible();
  });
});

test.describe('command palette and keyboard shortcuts', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'Keyboard features are checked on desktop.');
  });

  test('Ctrl+K lists every action with its shortcut; typing filters, Enter runs, Escape closes', async ({ page }) => {
    await openSample(page);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    const search = dialog.getByRole('combobox', { name: 'Search commands' });
    await expect(search).toBeFocused();

    for (const label of [
      'Copy image',
      'Download image',
      'Open another image',
      'Undo',
      'Redo',
      'Duplicate selection',
      'Delete selection',
      'Panel: Style',
      'Panel: Redact',
      'Panel: Find and copy text',
      'Panel: Export',
      'Select tool',
      'Arrow tool',
      'Line tool',
      'Rectangle tool',
      'Ellipse tool',
      'Text tool',
      'Step tool',
      'Blur tool',
      'Redact brush tool',
    ]) {
      await expect(dialog.getByRole('option', { name: label, exact: true }), label).toHaveCount(1);
    }
    await expect(dialog.getByRole('option', { name: 'Copy image', exact: true })).toHaveAttribute('aria-keyshortcuts', 'Control+C');
    await expect(dialog.getByRole('option', { name: 'Redo', exact: true })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+Z');

    // Typing filters; digits typed here are text, not panel shortcuts.
    await search.fill('zzzz');
    await expect(dialog.getByRole('status')).toContainText('No command matches');
    await search.fill('4');
    // The page behind a modal dialog is hidden from role queries, so ask for the tab by id.
    await expect(page.locator('#ed-tab-style')).toHaveAttribute('aria-selected', 'true');
    await search.fill('ell');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(studio(page)).toHaveAttribute('data-tool', 'ellipse');

    // Arrow keys move through the list; Ctrl+K toggles; Escape closes.
    await page.keyboard.press('Control+k');
    await search.fill('export');
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('option', { name: 'Panel: Export' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeHidden();
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Ctrl+S downloads, Ctrl+O opens the file picker, and 1 and 4 switch panels (never while typing)', async ({ page }) => {
    await openSample(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
    expect(download.suggestedFilename()).toMatch(/^polishot-\d{8}-\d{6}\.png$/);

    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
    expect(chooser.isMultiple()).toBe(false);

    await page.keyboard.press('4');
    await expect(page.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('1');
    await expect(page.getByRole('tab', { name: 'Style' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the Commands button in the bar opens the palette', async ({ page }) => {
    await openSample(page);
    await page.getByRole('button', { name: 'Commands' }).click();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Commands' })).toBeFocused();
  });
});

test.describe('the free tier', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'Desktop layout.');
  });

  /** Counts sharp horizontal colour changes in the two bottom corners of an exported PNG. */
  async function cornerEdges(page: Page, file: Buffer, scale: number) {
    return page.evaluate(async ([b64, scale]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const g = canvas.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      // Same sizing rule as the editor's watermark (packages/editor/src/watermark.ts), measured at 1x and scaled.
      const font = scale! * Math.min(30, Math.max(11, Math.round((Math.min(bmp.width, bmp.height) / scale!) * 0.02)));
      const w = Math.round(font * 11);
      const h = Math.round(font * 2.3);
      const edges = (x0: number) => {
        const d = g.getImageData(x0, bmp.height - h, w, h).data;
        let n = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 1; x < w; x++) {
            const i = (y * w + x) * 4;
            const j = i - 4;
            if (Math.abs(d[i]! - d[j]!) + Math.abs(d[i + 1]! - d[j + 1]!) + Math.abs(d[i + 2]! - d[j + 2]!) > 60) n++;
          }
        }
        return n;
      };
      return { right: edges(bmp.width - w), left: edges(0), width: bmp.width, height: bmp.height };
    }, [file.toString('base64'), scale] as const);
  }

  test('every export carries the small watermark in the bottom-right corner, at 1x and 2x', async ({ page }) => {
    await openSample(page);
    await page.getByRole('tab', { name: 'Export' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Export' });
    for (const scale of [1, 2] as const) {
      await panel.getByRole('button', { name: `Scale ${scale}x` }).click();
      const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Download' }).click()]);
      const stats = await cornerEdges(page, await readFile(await download.path()), scale);
      expect(stats.right, `${scale}x: text-like detail bottom-right`).toBeGreaterThan(40);
      expect(stats.left, `${scale}x: the opposite corner is smooth`).toBeLessThan(5);
    }
  });

  test('Pro features are visible but locked: the brand mark row opens pricing in a new tab', async ({ page }) => {
    await openSample(page);
    const row = page.getByRole('button', { name: /Brand mark is a Pro feature/ });
    await expect(row).toBeVisible();
    const [popup] = await Promise.all([page.waitForEvent('popup'), row.click()]);
    expect(new URL(popup.url()).pathname).toBe('/pricing');
    await popup.close();
    await expect(studio(page)).toBeVisible();
  });
});

test.describe('pure helpers', () => {
  const bytes = (...n: number[]) => Uint8Array.from(n);

  test('image files are recognised by their bytes, and their size is read from the header', () => {
    const png = new Uint8Array(TINY_PNG);
    expect(sniffKind(png)).toBe('png');
    expect(headerSize(png, 'png')).toEqual({ width: 1, height: 1 });
    expect(sniffKind(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffKind(Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)))))).toBe('webp');
    expect(sniffKind(Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0))))).toBeNull();
    expect(sniffKind(new Uint8Array(0))).toBeNull();
    expect(headerSize(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'png')).toBeNull();
  });

  test('recognition scale: small screenshots grow, huge ones shrink, normal ones stay', () => {
    expect(ocrScaleFor(500, 300)).toBe(2);
    expect(ocrScaleFor(2000, 1000)).toBe(1);
    expect(ocrScaleFor(8000, 4000)).toBe(0.5);
  });

  test('words come back in source pixels with reading-order lines; weak or empty boxes are dropped', () => {
    const word = (text: string, confidence: number, x0: number, y0: number, x1: number, y1: number) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });
    const blocks = [
      {
        paragraphs: [
          {
            lines: [
              { words: [word('Hello', 96, 20, 40, 100, 80), word('noise', 12, 110, 40, 150, 80), word('world', 90, 110, 40, 200, 80)] },
              { words: [word('', 99, 0, 0, 10, 10), word('flat', 99, 5, 5, 5, 20)] },
              { words: [word(' tail ', 88, 20, 100, 80, 140)] },
            ],
          },
        ],
      },
    ];
    expect(wordsFromBlocks(blocks, 2)).toEqual([
      { text: 'Hello', line: 0, box: { x: 10, y: 20, w: 40, h: 20 } },
      { text: 'world', line: 0, box: { x: 55, y: 20, w: 45, h: 20 } },
      { text: 'tail', line: 1, box: { x: 10, y: 50, w: 30, h: 20 } },
    ]);
    expect(wordsFromBlocks(null, 1)).toEqual([]);
    expect(wordsFromBlocks([{ paragraphs: null }], 1)).toEqual([]);
  });
});

test.describe('accessibility', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'Axe runs on the desktop layout; the mobile layout has its own check below.');
  });

  test('axe finds no violations with the command palette open', async ({ page }) => {
    await openSample(page);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.waitForTimeout(300);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 3) }))).toEqual([]);
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
