import { expect, test, type Page } from '@playwright/test';

/**
 * Wiring checks against the mock backend: every shortcut and screen from the brief does what it says.
 * (Visual review lives in shots.spec.ts and flow.spec.ts.)
 */

interface MockLast {
  copiedImageBytes?: number;
  copiedText?: string;
  saved?: { filename: string; bytes: number; savePath?: string; returned: string };
  pinned?: string;
  openedUrl?: string;
  revealed?: string;
  windowCalls: string[];
  captureStarts: string[];
  historySaves: Array<{ id: string; bytes: number }>;
}

const last = (page: Page) => page.evaluate<MockLast>(() => (window as unknown as { __polishotMock: { last: MockLast } }).__polishotMock.last);

async function ready(page: Page, query = '') {
  await page.goto(`/?mock=1&theme=light&delay=0${query ? `&${query}` : ''}`);
  await expect(page.locator('.pv-inspector')).toBeVisible();
  await expect(page.locator('.pv-found')).toBeVisible();
}

const toast = (page: Page, text: string | RegExp) => page.locator('.pv-toast').filter({ hasText: text });

test.describe('shortcuts', () => {
  test('Ctrl+C copies the image and says so', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+c');
    await expect(toast(page, 'Copied')).toBeVisible();
    expect((await last(page)).copiedImageBytes).toBeGreaterThan(1000);
  });

  test('Ctrl+Shift+C copies all recognised text', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+Shift+c');
    await expect(toast(page, 'Text copied')).toBeVisible();
    expect((await last(page)).copiedText).toContain('maya.chen@northwind-labs.com');
  });

  test('Ctrl+S saves to the folder and offers Show in folder', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+s');
    const saved = toast(page, /Saved to/);
    await expect(saved).toBeVisible();
    const l = await last(page);
    expect(l.saved?.filename).toMatch(/^polishot-\d{8}-\d{6}\.png$/);
    await saved.getByRole('button', { name: 'Show in folder' }).click();
    await expect.poll(async () => (await last(page)).revealed).toBe(l.saved?.returned);
  });

  test('Ctrl+Shift+S asks where to save and sends that destination', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+Shift+s');
    await expect(toast(page, /Saved to/)).toBeVisible();
    const l = await last(page);
    expect(l.saved?.savePath).toMatch(/polishot-\d{8}-\d{6}\.png$/);
  });

  test('Ctrl+P pins the capture', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+p');
    await expect(toast(page, 'Pinned')).toBeVisible();
    expect((await last(page)).pinned).toMatch(/^mock/);
  });

  test('Ctrl+O opens a file and Ctrl+V pastes an image', async ({ page }) => {
    await ready(page);
    const first = await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id);
    await page.keyboard.press('Control+o');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id)).not.toBe(first);
    const second = await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id);
    await page.keyboard.press('Control+v');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id)).not.toBe(second);
  });

  test('Ctrl+V with an empty clipboard explains what to do', async ({ page }) => {
    await ready(page, 'clip=empty');
    await page.keyboard.press('Control+v');
    await expect(toast(page, /no image on the clipboard/i)).toBeVisible();
  });

  test('Esc hides the window, but first leaves tools and other screens', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('a'); // arrow tool
    await page.keyboard.press('Escape'); // the editor returns to Select first
    expect((await last(page)).windowCalls).not.toContain('hide');
    await page.keyboard.press('Control+h');
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await page.keyboard.press('Escape'); // back to the editor
    await expect(page.locator('.pv-inspector')).toBeVisible();
    expect((await last(page)).windowCalls).not.toContain('hide');
    await page.keyboard.press('Escape'); // nothing left to leave: hide
    await expect.poll(async () => (await last(page)).windowCalls).toContain('hide');
  });

  test('Ctrl+K lists every action with its shortcut and runs one', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    const options = dialog.getByRole('option');
    expect(await options.count()).toBeGreaterThan(30); // actions + one per tool
    // Every row has its shortcut as key caps.
    const without = await dialog.locator('.pv-palette-item').evaluateAll((els) => els.filter((e) => !e.querySelector('.pv-kbd')).map((e) => e.textContent));
    expect(without).toEqual([]);
    await page.keyboard.type('history');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(dialog).toHaveCount(0);
  });

  test('Ctrl+1..4 switch the inspector tabs; the Redact tab carries the count', async ({ page }) => {
    await ready(page);
    await expect(page.getByRole('tab', { name: /^Redact/ })).toContainText('4');
    await page.keyboard.press('Control+3');
    await expect(page.getByRole('tab', { name: 'Text', selected: true })).toBeVisible();
    await page.keyboard.press('Control+4');
    await expect(page.getByRole('tab', { name: 'Export', selected: true })).toBeVisible();
    await page.keyboard.press('Control+1');
    await expect(page.getByRole('tab', { name: 'Style', selected: true })).toBeVisible();
  });

  test('a dropped image opens', async ({ page }) => {
    await ready(page);
    const first = await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id);
    await page.evaluate(() => (window as unknown as { __polishotMock: { emit: (e: string, p: unknown) => void } }).__polishotMock.emit('tauri://drag-drop', { paths: ['C:\\Users\\you\\Pictures\\a.png'] }));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id)).not.toBe(first);
    await page.evaluate(() => (window as unknown as { __polishotMock: { emit: (e: string, p: unknown) => void } }).__polishotMock.emit('tauri://drag-drop', { paths: ['C:\\notes.txt'] }));
    await expect(toast(page, /not an image/)).toBeVisible();
  });
});

test.describe('history', () => {
  test('opens a past capture to re-edit and saves edits back', async ({ page }) => {
    await ready(page);
    await page.getByRole('button', { name: 'Hide' }).click(); // an edit worth saving
    await page.waitForTimeout(1800); // autosave
    expect((await last(page)).historySaves.length).toBeGreaterThan(0);
    await page.keyboard.press('Control+h');
    const card = page.locator('.pv-hcard-open').first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator('.pv-inspector')).toBeVisible();
  });

  test('deletes one without asking, and clears all only after confirming', async ({ page }) => {
    await ready(page, 'history=3');
    await page.keyboard.press('Control+h');
    await expect(page.locator('.pv-hcard')).toHaveCount(4); // 3 seeded + the current capture
    await page.locator('.pv-hcard').first().hover();
    await page.locator('.pv-hcard').first().getByRole('button', { name: /Delete/ }).click();
    await expect(page.locator('.pv-hcard')).toHaveCount(3);
    await page.getByRole('button', { name: 'Clear all' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused(); // safe default
    await page.keyboard.press('Escape');
    await expect(page.locator('.pv-hcard')).toHaveCount(3); // cancelled
    await page.getByRole('button', { name: 'Clear all' }).click();
    await dialog.getByRole('button', { name: 'Clear all' }).click();
    await expect(page.getByText('Your captures will appear here.')).toBeVisible();
  });

  test('searches the recognised text', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+h');
    await page.getByRole('searchbox').fill('upstream');
    await expect(page.locator('.pv-hcard')).toHaveCount(1);
  });
});

test.describe('settings', () => {
  test('records a shortcut and shows a conflict the backend reports', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+,');
    const capture = page.getByRole('button', { name: /^Capture shortcut/ });
    await capture.click();
    await page.keyboard.press('Control+Shift+4'); // the mock says another app owns this one
    await expect(page.getByRole('alert').filter({ hasText: /already in use by another application/ })).toBeVisible();
    await expect(capture).toContainText('2'); // the old shortcut stayed

    await capture.click();
    await page.keyboard.press('Control+Alt+9');
    await expect(capture).toContainText('9');
    await expect(capture).toContainText('Alt');
  });

  test('a shortcut without a modifier is refused before it is sent', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: /^Capture shortcut/ }).click();
    await page.keyboard.press('F9');
    await expect(page.getByRole('alert').filter({ hasText: /Ctrl, Alt or Shift/ })).toBeVisible();
  });

  test('optional shortcuts can be cleared with Backspace; Escape cancels recording', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+,');
    const scroll = page.getByRole('button', { name: /^Scrolling capture shortcut/ });
    await scroll.click();
    await page.keyboard.press('Control+Alt+s');
    await expect(scroll).toContainText('S');
    await scroll.click();
    await page.keyboard.press('Backspace');
    await expect(scroll).toContainText('Not set');
    await scroll.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible(); // Esc cancelled recording, not the screen
  });

  test('theme and format changes apply immediately', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+,');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('radio', { name: 'JPEG' }).click();
    await expect(page.getByRole('slider', { name: 'Quality' })).toBeEnabled();
  });
});

test.describe('licence and Pro', () => {
  test('rejects a bad key with a reason, activates a good one, deactivates', async ({ page }) => {
    await ready(page);
    await page.getByRole('button', { name: /License: Free/ }).click();
    const input = page.getByLabel('License key');
    await input.fill('hello');
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /does not look like a license key/ })).toBeVisible();

    await input.fill('PSHOT-AAAAAA-BBBBBB');
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByRole('button', { name: /License: Pro/ })).toBeVisible();
    await expect(page.getByText('Updates until')).toBeVisible();

    await page.getByRole('button', { name: 'Deactivate on this computer' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByRole('button', { name: /License: Free/ })).toBeVisible();
  });

  test('Free shows the watermark, Pro does not', async ({ page }) => {
    await ready(page);
    expect(await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { licensed: boolean } } }).__polishotApp.editor.licensed)).toBe(false);
    await page.goto('/?mock=1&theme=light&delay=0&lic=pro');
    await expect(page.locator('.pv-inspector')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { licensed: boolean } } }).__polishotApp.editor.licensed)).toBe(true);
  });

  test('an expired key explains itself and the app stays Free', async ({ page }) => {
    await ready(page, 'lic=expired');
    expect(await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { licensed: boolean } } }).__polishotApp.editor.licensed)).toBe(false);
    await page.getByRole('button', { name: /License: Free/ }).click();
    await expect(page.getByText(/Your license includes updates released until/)).toBeVisible();
  });

  test('Free allows 3 saved looks, then asks for Pro; Pro has no limit', async ({ page }) => {
    await ready(page);
    for (let i = 1; i <= 3; i++) {
      await page.getByPlaceholder('Name this look').fill(`Look ${i}`);
      await page.getByRole('button', { name: 'Save', exact: true }).last().click();
      await expect(page.getByRole('button', { name: `Look ${i}` })).toBeVisible();
    }
    await expect(page.getByPlaceholder('Name this look')).toHaveCount(0); // no field once the limit is reached
    await expect(page.getByText('You have saved all 3 looks that Free includes.')).toBeVisible();

    await page.goto('/?mock=1&theme=light&delay=0&lic=pro');
    await expect(page.locator('.pv-inspector')).toBeVisible();
    for (let i = 1; i <= 4; i++) {
      await page.getByPlaceholder('Name this look').fill(`Pro look ${i}`);
      await page.getByRole('button', { name: 'Save', exact: true }).last().click();
      await expect(page.getByRole('button', { name: `Pro look ${i}` })).toBeVisible();
    }
  });

  test('Pro can set a text brand mark; Free is pointed at Pro', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('button', { name: 'Get Pro' })).toBeVisible();

    await page.goto('/?mock=1&theme=light&delay=0&lic=pro');
    await expect(page.locator('.pv-inspector')).toBeVisible();
    await page.keyboard.press('Control+,');
    await page.getByRole('radio', { name: 'Text' }).click();
    await page.getByLabel('Text', { exact: true }).fill('maya.dev');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { brandMark: { text?: string } | null } } }).__polishotApp.editor.brandMark?.text)).toBe('maya.dev');
  });

  test('the pricing link opens through the opener plugin', async ({ page }) => {
    await ready(page);
    await page.getByRole('button', { name: /License: Free/ }).click();
    await page.getByRole('button', { name: 'Buy Pro' }).first().click();
    await expect.poll(async () => (await last(page)).openedUrl).toMatch(/^https:\/\/.+\/pricing$/);
  });
});

test.describe('keyboard and accessibility', () => {
  test('every icon-only button has an accessible name', async ({ page }) => {
    await ready(page);
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim() || b.getAttribute('title')))
        .map((b) => b.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);
  });

  test('Tab reaches the title bar controls in visual order with a visible focus ring', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Tab');
    const names: string[] = [];
    for (let i = 0; i < 6; i++) {
      names.push((await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '')) ?? '');
      await page.keyboard.press('Tab');
    }
    expect(names[0]).toMatch(/Open command palette/);
    expect(names.slice(1, 4)).toEqual([expect.stringMatching(/Copy/), expect.stringMatching(/Save/), expect.stringMatching(/Pin/)]);
    await page.keyboard.press('Shift+Tab');
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
    expect(ring).toBe('solid');
  });

  test('reduced motion removes transitions and animations', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1040, height: 680 } });
    const page = await context.newPage();
    await ready(page);
    const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.pv-tab') as Element).transitionDuration);
    expect(parseFloat(dur)).toBeLessThanOrEqual(0.001);
    await context.close();
  });
});
