import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Quick send, scrolling capture / GIF entry points and batch beautify, against the mock backend
 * (see src/shared/mock/mockBackend.ts: `qs=none|one|two|offline`, `batch=N`, `lic=pro`).
 * Screenshots of the new screens go to e2e/screenshots/qs-*.png and batch-*.png.
 */
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`) });

interface MockLast {
  sent: Array<{ deviceId: string; filename: string; bytes: number }>;
  forgotten: string[];
  incomingAnswers: Array<{ requestId: number; accept: boolean }>;
  pairingMode: boolean;
  pairAnswers: boolean[];
  pairConfirmArgs: Array<{ peerId: string; sas: string }>;
  windowCalls: string[];
  captureStarts: string[];
  savedPaths: string[];
  revealed?: string;
}

const last = (page: Page) => page.evaluate<MockLast>(() => (window as unknown as { __polishotMock: { last: MockLast } }).__polishotMock.last);
type QsHelper = 'pairFromPhone' | 'secondPairCode' | 'incoming' | 'receive';
/** Simulates the phone side (see window.__polishotMock.qs in the mock backend). */
const phone = (page: Page, name: QsHelper, ...args: number[]) =>
  page.evaluate(
    ([n, a]) => (window as unknown as { __polishotMock: { qs: Record<string, (...x: number[]) => unknown> } }).__polishotMock.qs[n as string]!(...(a as number[])),
    [name, args] as const,
  );
const pairedCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __polishotMock: { qs: { devices(): Array<{ paired: boolean }> } } }).__polishotMock.qs.devices().filter((d) => d.paired).length);
const imageId = (page: Page) =>
  page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id);

async function ready(page: Page, query = '') {
  await page.goto(`/?mock=1&theme=light&delay=0${query ? `&${query}` : ''}`);
  await expect(page.locator('.pv-inspector')).toBeVisible();
  await expect(page.locator('.pv-found')).toBeVisible();
}

const toast = (page: Page, text: string | RegExp) => page.locator('.pv-toast').filter({ hasText: text });

test.describe('send to phone', () => {
  test('one phone in range: Ctrl+Shift+D sends straight to it', async ({ page }) => {
    await ready(page, 'qs=one');
    await page.keyboard.press('Control+Shift+d');
    await expect(toast(page, 'Sent to Pixel 8')).toBeVisible();
    const l = await last(page);
    expect(l.sent).toHaveLength(1);
    expect(l.sent[0]!.deviceId).toBe('PIXELEIGHT0000AA');
    expect(l.sent[0]!.filename).toMatch(/^polishot-\d{8}-\d{6}\.png$/);
    expect(l.sent[0]!.bytes).toBeGreaterThan(1000);
  });

  test('says it is sending while the phone decides, then dismisses that message', async ({ page }) => {
    await ready(page, 'qs=one&qsdelay=900');
    await page.getByRole('button', { name: /^Send to/ }).click();
    await expect(toast(page, 'Sending to Pixel 8')).toBeVisible();
    await expect(toast(page, 'Sent to Pixel 8')).toBeVisible();
    await expect(toast(page, 'Sending to Pixel 8')).toHaveCount(0);
  });

  test('the Send button names the phone once the list is known', async ({ page }) => {
    await ready(page, 'qs=one');
    await page.getByRole('button', { name: /^Send to/ }).click();
    await expect(toast(page, 'Sent to Pixel 8')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send to Pixel 8' })).toBeVisible();
  });

  test('two phones: a menu lets you pick, and Escape closes it without hiding the window', async ({ page }) => {
    await ready(page, 'qs=two');
    await page.getByRole('button', { name: /^Send to/ }).click();
    const menu = page.getByRole('menu', { name: 'Send to a phone' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Pixel 8/ })).toBeFocused(); // keyboard users land on the first phone
    await shot(page, 'qs-01-menu');
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: /Galaxy S24/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect((await last(page)).windowCalls).not.toContain('hide');
    await expect(page.getByRole('button', { name: /^Send to/ })).toBeFocused(); // focus goes back where it was

    await page.getByRole('button', { name: /^Send to/ }).click();
    await menu.getByRole('menuitem', { name: /Galaxy S24/ }).click();
    await expect(toast(page, 'Sent to Galaxy S24')).toBeVisible();
    expect((await last(page)).sent.at(-1)!.deviceId).toBe('GALAXYSTWENTYFOU');
  });

  test('a phone that is out of range is listed, dimmed, and cannot be chosen', async ({ page }) => {
    await ready(page, 'qs=offline');
    await page.getByRole('button', { name: /^Send to/ }).click();
    const menu = page.getByRole('menu', { name: 'Send to a phone' });
    const item = menu.getByRole('menuitem', { name: /Pixel 8/ });
    await expect(item).toContainText('Not nearby');
    await item.click({ force: true });
    expect((await last(page)).sent).toHaveLength(0);
    await expect(menu).toBeVisible(); // still open: nothing happened
    await shot(page, 'qs-02-menu-offline');
  });

  test('when the only phone leaves the network, Send offers the menu instead of failing', async ({ page }) => {
    await ready(page, 'qs=one');
    await page.getByRole('button', { name: /^Send to/ }).click();
    await expect(toast(page, 'Sent to Pixel 8')).toBeVisible();
    await page.evaluate(() => {
      const m = (window as unknown as { __polishotMock: { qs: { devices(): Array<{ online: boolean }> } } }).__polishotMock;
      m.qs.devices()[0]!.online = false;
    });
    await page.keyboard.press('Control+Shift+d');
    await expect(page.getByRole('menu', { name: 'Send to a phone' })).toBeVisible();
  });

  test('a send the phone refuses says so, and the "sending" message goes away', async ({ page }) => {
    await ready(page, 'qs=one&qsfail=1');
    await page.keyboard.press('Control+Shift+d');
    await expect(toast(page, 'Pixel 8 declined the image.')).toBeVisible();
    await expect(toast(page, 'Sending to Pixel 8')).toHaveCount(0);
    expect((await last(page)).sent).toHaveLength(0);
  });
});

test.describe('pairing', () => {
  test('first time: Send opens the pairing dialog, which says what Windows will ask', async ({ page }) => {
    await ready(page, 'qs=none');
    await page.keyboard.press('Control+Shift+d');
    const dialog = page.getByRole('dialog', { name: 'Pair a phone' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Choose Private networks');
    await expect(dialog).toContainText('Pair a new device');
    await expect.poll(async () => (await last(page)).pairingMode).toBe(true);
    await shot(page, 'qs-03-pair-browse');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await last(page)).pairingMode).toBe(false); // the window for new devices closes with it
  });

  test('pick the phone, compare the codes, confirm: paired, and Send now goes straight to it', async ({ page }) => {
    await ready(page, 'qs=none');
    await page.keyboard.press('Control+Shift+d');
    await page.getByRole('button', { name: 'Pair with Maya’s Pixel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Compare the codes' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.pv-pair-code')).toHaveText('042 917');
    await expect(dialog).toContainText('Does Maya’s Pixel show the same code?');
    // The code is never confirmed for the user.
    expect((await last(page)).pairAnswers).toEqual([]);
    await shot(page, 'qs-04-pair-compare');
    await dialog.getByRole('button', { name: 'They match' }).click();
    const done = page.getByRole('dialog', { name: 'Paired' });
    await expect(done).toContainText('Paired with Maya’s Pixel');
    await shot(page, 'qs-05-pair-done');
    expect((await last(page)).pairAnswers).toEqual([true]);
    // The answer names the device and digits that were on screen, so it can only apply to that prompt.
    expect((await last(page)).pairConfirmArgs).toEqual([{ peerId: 'MAYASPHONE00000B', sas: '042 917' }]);
    await done.getByRole('button', { name: 'Done' }).click();
    await expect(done).toHaveCount(0);

    await page.keyboard.press('Control+Shift+d');
    await expect(toast(page, 'Sent to Maya’s Pixel')).toBeVisible();
  });

  test('"They don’t match" pairs nothing and offers another try', async ({ page }) => {
    await ready(page, 'qs=none');
    await page.keyboard.press('Control+Shift+d');
    await page.getByRole('button', { name: 'Pair with Maya’s Pixel' }).click();
    await page.getByRole('button', { name: 'They don’t match' }).click();
    const failed = page.getByRole('dialog', { name: 'Pairing didn’t finish' });
    await expect(failed).toContainText('the codes did not match');
    expect((await last(page)).pairAnswers).toEqual([false]);
    await shot(page, 'qs-06-pair-mismatch');
    await failed.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('dialog', { name: 'Pair a phone' })).toBeVisible();
    expect(await pairedCount(page)).toBe(0);
  });

  test('closing the dialog on the code counts as "no"', async ({ page }) => {
    await ready(page, 'qs=none');
    await page.keyboard.press('Control+Shift+d');
    await page.getByRole('button', { name: 'Pair with Maya’s Pixel' }).click();
    await expect(page.getByRole('dialog', { name: 'Compare the codes' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await last(page)).pairAnswers).toEqual([false]);
  });

  test('a phone that starts pairing shows its code here too', async ({ page }) => {
    await ready(page, 'qs=none');
    await page.keyboard.press('Control+Shift+p');
    await expect(page.getByRole('dialog', { name: 'Pair a phone' })).toBeVisible();
    await phone(page, 'pairFromPhone');
    await expect(page.getByRole('dialog', { name: 'Compare the codes' })).toBeVisible();
  });

  test('a second device trying to pair never replaces the code being compared', async ({ page }) => {
    await ready(page, 'qs=none');
    await page.keyboard.press('Control+Shift+d');
    await page.getByRole('button', { name: 'Pair with Maya’s Pixel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Compare the codes' });
    await expect(dialog.locator('.pv-pair-code')).toHaveText('042 917');
    await phone(page, 'secondPairCode');
    await expect(dialog.getByRole('alert')).toContainText('Another device is trying to pair');
    await shot(page, 'qs-09-pair-another-device');
    // Still the same code, the same device, and still unanswered.
    await expect(dialog.locator('.pv-pair-code')).toHaveText('042 917');
    await expect(dialog).toContainText('Does Maya’s Pixel show the same code?');
    await expect(dialog.getByRole('button', { name: 'They match' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'They match' }).click();
    await expect(page.getByRole('dialog', { name: 'Paired' })).toContainText('Maya’s Pixel');
    expect((await last(page)).pairConfirmArgs).toEqual([{ peerId: 'MAYASPHONE00000B', sas: '042 917' }]);
  });

  test('the dialog keeps focus inside and its primary button is focused first', async ({ page }) => {
    await ready(page, 'qs=none');
    await page.keyboard.press('Control+Shift+d');
    await page.getByRole('button', { name: 'Pair with Maya’s Pixel' }).click();
    const match = page.getByRole('button', { name: 'They match' });
    await expect(match).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'They don’t match' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(match).toBeFocused(); // Tab wraps inside the dialog; it never reaches the page behind
  });

  test('Settings lists paired phones, and forgetting one is a single click', async ({ page }) => {
    await ready(page, 'qs=two');
    await page.getByRole('button', { name: /^Send to/ }).click(); // asks for the list (Settings only shows what is known)
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('heading', { name: 'Phone' })).toBeVisible();
    await expect(page.getByText('Galaxy S24')).toBeVisible();
    await page.locator('.pv-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await shot(page, 'qs-07-settings-phone');
    await page.getByRole('button', { name: 'Forget Galaxy S24' }).click();
    await expect(toast(page, 'Forgot Galaxy S24')).toBeVisible();
    await expect(page.getByText('Galaxy S24')).toHaveCount(0);
    expect((await last(page)).forgotten).toEqual(['GALAXYSTWENTYFOU']);
  });

  test('Settings → Pair a phone opens the same dialog', async ({ page }) => {
    await ready(page, 'qs=none');
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Pair a phone' }).click();
    await expect(page.getByRole('dialog', { name: 'Pair a phone' })).toBeVisible();
  });
});

test.describe('receiving', () => {
  test('a prompt waits for an answer, Accept opens what arrives', async ({ page }) => {
    await ready(page, 'qs=one');
    await phone(page, 'incoming', 7);
    const card = page.locator('.pv-incoming-card');
    await expect(card).toContainText('Pixel 8 wants to send you an image');
    await expect(card).toContainText('screenshot.png · 1.2 MB');
    await shot(page, 'qs-08-incoming');
    // It never takes focus, so typing in the editor is not interrupted.
    await expect(card.getByRole('button', { name: 'Accept' })).not.toBeFocused();
    const before = await imageId(page);
    await card.getByRole('button', { name: 'Accept' }).click();
    await expect(card).toHaveCount(0);
    expect((await last(page)).incomingAnswers).toEqual([{ requestId: 7, accept: true }]);
    await phone(page, 'receive');
    await expect.poll(() => imageId(page)).not.toBe(before);
    await expect(toast(page, 'Received from Pixel 8')).toBeVisible();
  });

  test('Decline answers no and removes the prompt', async ({ page }) => {
    await ready(page, 'qs=one');
    await phone(page, 'incoming', 9);
    await page.getByRole('button', { name: 'Decline' }).click();
    await expect(page.locator('.pv-incoming-card')).toHaveCount(0);
    expect((await last(page)).incomingAnswers).toEqual([{ requestId: 9, accept: false }]);
  });

  test('several prompts stack, each answered on its own', async ({ page }) => {
    await ready(page, 'qs=one');
    await (async () => { await phone(page, 'incoming', 1); await phone(page, 'incoming', 2); })();
    await expect(page.locator('.pv-incoming-card')).toHaveCount(2);
    await page.locator('.pv-incoming-card').first().getByRole('button', { name: 'Decline' }).click();
    await expect(page.locator('.pv-incoming-card')).toHaveCount(1);
    expect((await last(page)).incomingAnswers).toEqual([{ requestId: 1, accept: false }]);
  });
});

test.describe('capture modes', () => {
  test('the palette starts a scrolling capture, and the stitched result opens', async ({ page }) => {
    await ready(page);
    const before = await imageId(page);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('scrolling');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await last(page)).captureStarts).toContain('scroll');
    await expect.poll(() => imageId(page)).not.toBe(before);
  });

  test('Ctrl+Shift+G records a GIF and the finished file can be shown in its folder', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+Shift+g');
    await expect.poll(async () => (await last(page)).captureStarts).toContain('gif');
    const saved = toast(page, /GIF saved: Recording/);
    await expect(saved).toBeVisible();
    await saved.getByRole('button', { name: 'Show in folder' }).click();
    await expect.poll(async () => (await last(page)).revealed).toMatch(/Recording .*\.gif$/);
  });
});

test.describe('batch beautify', () => {
  test('Ctrl+Shift+O: choose the look, run, and every image is saved next to the others', async ({ page }) => {
    await ready(page, 'batch=3');
    await page.keyboard.press('Control+Shift+o');
    const dialog = page.getByRole('dialog', { name: 'Batch beautify' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveCount(3);
    await expect(dialog).toContainText('3 images will be saved as PNG');
    await shot(page, 'batch-01-choose');
    await dialog.getByRole('button', { name: 'Beautify 3 images' }).click();
    await expect(dialog).toContainText('3 images saved.', { timeout: 30_000 });
    await shot(page, 'batch-02-done');
    const saved = (await last(page)).savedPaths;
    expect(saved).toHaveLength(3);
    expect(saved.map((p) => p.split('\\').pop())).toEqual(['shot-1-polished.png', 'shot-2-polished.png', 'shot-3-polished.png']);
    await dialog.getByRole('button', { name: 'Show in folder' }).click();
    await expect.poll(async () => (await last(page)).revealed).toBe(saved[0]);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('Free runs take 5 images and the dialog says what was left out', async ({ page }) => {
    await ready(page, 'batch=8');
    await page.keyboard.press('Control+Shift+o');
    const dialog = page.getByRole('dialog', { name: 'Batch beautify' });
    await expect(dialog.getByRole('listitem')).toHaveCount(5);
    await expect(dialog).toContainText('Free handles 5 images per run, so 3 images were left out.');
    await shot(page, 'batch-03-free-limit');
    await dialog.getByRole('button', { name: 'Beautify 5 images' }).click();
    await expect(dialog).toContainText('5 images saved.', { timeout: 40_000 });
    expect((await last(page)).savedPaths).toHaveLength(5);
  });

  test('Pro has no limit', async ({ page }) => {
    await ready(page, 'batch=8&lic=pro');
    await page.keyboard.press('Control+Shift+o');
    const dialog = page.getByRole('dialog', { name: 'Batch beautify' });
    await expect(dialog.getByRole('listitem')).toHaveCount(8);
    await expect(dialog).not.toContainText('left out');
    await expect(dialog.getByRole('button', { name: 'Beautify 8 images' })).toBeVisible();
  });

  test('the history is left as it was (the originals it registered are removed again)', async ({ page }) => {
    await ready(page, 'batch=2&history=3');
    await page.keyboard.press('Control+h');
    const count = await page.locator('.pv-hcard').count();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+o');
    const dialog = page.getByRole('dialog', { name: 'Batch beautify' });
    await dialog.getByRole('button', { name: 'Beautify 2 images' }).click();
    await expect(dialog).toContainText('2 images saved.', { timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.keyboard.press('Control+h');
    await expect(page.locator('.pv-hcard')).toHaveCount(count);
  });

  test('the open capture is not disturbed by a batch run', async ({ page }) => {
    await ready(page, 'batch=2');
    const before = await imageId(page);
    await page.keyboard.press('Control+Shift+o');
    const dialog = page.getByRole('dialog', { name: 'Batch beautify' });
    await dialog.getByRole('button', { name: 'Beautify 2 images' }).click();
    await expect(dialog).toContainText('2 images saved.', { timeout: 30_000 });
    expect(await imageId(page)).toBe(before);
  });

  test('Escape on the choose step cancels; on a run it stops after the current image', async ({ page }) => {
    await ready(page, 'batch=4');
    await page.keyboard.press('Control+Shift+o');
    const dialog = page.getByRole('dialog', { name: 'Batch beautify' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await last(page)).savedPaths).toHaveLength(0);
  });

  test('several images dropped together offer the batch, one image just opens', async ({ page }) => {
    await ready(page);
    await page.evaluate(() =>
      (window as unknown as { __polishotMock: { emit: (e: string, p: unknown) => void } }).__polishotMock.emit('tauri://drag-drop', {
        paths: ['C:\\a.png', 'C:\\b.jpg', 'C:\\notes.txt'],
      }),
    );
    const dialog = page.getByRole('dialog', { name: 'Batch beautify' });
    await expect(dialog.getByRole('listitem')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: 'Beautify 2 images' })).toBeVisible();
  });
});

test.describe('the Pro brand mark in the Style tab', () => {
  test('typing a mark with a space is not rewritten, and it is remembered', async ({ page }) => {
    await ready(page, 'lic=pro');
    const section = page.getByRole('region', { name: 'Brand mark' });
    await section.scrollIntoViewIfNeeded();
    await section.getByRole('button', { name: 'Text brand mark' }).click();
    const input = section.getByRole('textbox', { name: 'Brand mark text' });
    await input.pressSequentially('maya dev');
    await expect(input).toHaveValue('maya dev');
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('polishot.brandMark.v1'))).toContain('maya dev');
    await shot(page, 'brand-01-style-tab-pro');
  });

  test('Free sees one quiet locked row that leads to the license screen', async ({ page }) => {
    await ready(page);
    const lock = page.getByRole('button', { name: /Brand mark is a Pro feature/ });
    await lock.scrollIntoViewIfNeeded();
    await lock.click();
    await expect(page.getByRole('heading', { name: 'License' })).toBeVisible();
  });
});
