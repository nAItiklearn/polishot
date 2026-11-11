import { expect, test, type Page } from '@playwright/test';

/**
 * The finishing checks for the desktop UI against the mock backend: the warm paper look the owner asked
 * for (light and dark), the editing keys of docs/UX-BAR.md as they behave inside the app, the history
 * grid, the license screen and the pin window.
 */

interface MockLast {
  windowCalls: string[];
}

const last = (page: Page) => page.evaluate<MockLast>(() => (window as unknown as { __polishotMock: { last: MockLast } }).__polishotMock.last);

async function ready(page: Page, query = '') {
  await page.goto(`/?mock=1&theme=light&delay=0${query ? `&${query}` : ''}`);
  await expect(page.locator('.pv-inspector')).toBeVisible();
  await expect(page.locator('.pv-found')).toBeVisible();
}

const token = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(), name);

type EditorHandle = { __polishotApp: { editor: any } };

test.describe('warm paper look', () => {
  test('light is cream paper with near-black ink, and the keycaps are dark and rounded', async ({ page }) => {
    await ready(page);
    expect(await token(page, '--ps-bg')).toBe('#f7f2ea');
    expect(await token(page, '--ps-surface')).toBe('#fffdf9');
    expect(await token(page, '--ps-text')).toBe('#161615');
    const cap = await page.locator('.pv-kbd').first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, radius: parseFloat(s.borderTopLeftRadius) };
    });
    expect(cap.bg).toBe('rgb(42, 39, 35)');
    expect(cap.radius).toBeGreaterThanOrEqual(5);
  });

  test('dark keeps the same family, a step warmer than the shared tokens', async ({ page }) => {
    await page.goto('/?mock=1&theme=dark&delay=0');
    await expect(page.locator('.pv-inspector')).toBeVisible();
    expect(await token(page, '--ps-bg')).toBe('#100f0d');
    expect(await token(page, '--ps-text')).toBe('#f1ece3');
    expect(await token(page, '--ps-accent')).toBe('#ee7444'); // the brand accent is untouched
  });

  test('"system" follows the operating system', async ({ browser }) => {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1040, height: 680 } });
      const page = await context.newPage();
      await page.goto('/?mock=1&theme=system&delay=0');
      await expect(page.locator('.pv-inspector')).toBeVisible();
      expect(await token(page, '--ps-bg')).toBe(scheme === 'light' ? '#f7f2ea' : '#100f0d');
      await context.close();
    }
  });

  test('the title bar shows the Print P mark, not a stand-in', async ({ page }) => {
    await ready(page);
    const paths = await page.locator('.pv-brand svg path').evaluateAll((els) => els.map((e) => (e.getAttribute('d') ?? '').slice(0, 24)));
    expect(paths).toEqual(['M14.5 26.6L18.5 26.6A3 3', 'M17.448 10.992L42.311 8.']);
  });
});

test.describe('editing keys inside the app (UX-BAR)', () => {
  interface Probe {
    annotations: Array<{ id: string; type: string; x?: number; y?: number }>;
    selected: string | null;
  }
  const probe = (page: Page) =>
    page.evaluate<Probe>(() => {
      const ed = (window as unknown as EditorHandle).__polishotApp.editor;
      return { annotations: ed.doc.annotations, selected: ed.selectedId };
    });
  const contentBox = (page: Page) =>
    page.evaluate(() => {
      const ed = (window as unknown as EditorHandle).__polishotApp.editor;
      const r = ed.contentRectOnScreen();
      const host = ed.element.getBoundingClientRect();
      return { x: host.x + r.x, y: host.y + r.y, w: r.w, h: r.h };
    });

  async function drawRect(page: Page) {
    await page.keyboard.press('r');
    const box = await contentBox(page);
    await page.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.4, box.y + box.h * 0.35, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('v'); // back to Select
    // Click the outline's top edge to select it, as a person would.
    await page.mouse.click(box.x + box.w * 0.3, box.y + box.h * 0.2);
    expect((await probe(page)).selected, 'the rectangle is selected').not.toBeNull();
  }

  test('arrow keys nudge the selection 1 px, Shift+arrow 10 px, each press its own undo step', async ({ page }) => {
    await ready(page);
    await drawRect(page);
    const start = (await probe(page)).annotations.find((a) => a.type === 'rect')!;
    expect(start).toBeTruthy();
    await page.keyboard.press('ArrowRight');
    expect((await probe(page)).annotations.find((a) => a.id === start.id)!.x).toBeCloseTo(start.x! + 1, 3);
    await page.keyboard.press('Shift+ArrowDown');
    expect((await probe(page)).annotations.find((a) => a.id === start.id)!.y).toBeCloseTo(start.y! + 10, 3);
    await page.keyboard.press('Control+z');
    expect((await probe(page)).annotations.find((a) => a.id === start.id)!.y).toBeCloseTo(start.y!, 3);
    // The app's own shortcuts did not swallow the keys: nothing was hidden.
    expect((await last(page)).windowCalls).not.toContain('hide');
  });

  test('Ctrl+D duplicates the selection, selects the copy, and one undo removes it', async ({ page }) => {
    await ready(page);
    await drawRect(page);
    const before = await probe(page);
    await page.keyboard.press('Control+d');
    const after = await probe(page);
    expect(after.annotations.length).toBe(before.annotations.length + 1);
    expect(after.selected).not.toBe(before.selected);
    await page.keyboard.press('Control+z');
    expect((await probe(page)).annotations.length).toBe(before.annotations.length);
  });

  test('numbered steps renumber after a delete, and the deletion is one undo', async ({ page }) => {
    await ready(page);
    const box = await contentBox(page);
    await page.keyboard.press('n');
    for (const fx of [0.25, 0.4, 0.55]) await page.mouse.click(box.x + box.w * fx, box.y + box.h * 0.8);
    const numbers = () =>
      page.evaluate(() =>
        (window as unknown as EditorHandle).__polishotApp.editor.doc.annotations.filter((a: { type: string }) => a.type === 'step').map((a: { n: number }) => a.n),
      );
    expect(await numbers()).toEqual([1, 2, 3]);
    await page.keyboard.press('v');
    await page.mouse.click(box.x + box.w * 0.25, box.y + box.h * 0.8);
    expect((await probe(page)).selected, 'the first step is selected').not.toBeNull();
    await page.keyboard.press('Delete');
    expect(await numbers()).toEqual([1, 2]);
    await page.keyboard.press('Control+z');
    expect(await numbers()).toEqual([1, 2, 3]);
  });

  test('the padding slider nudges with the arrow keys and double-click resets it', async ({ page }) => {
    await ready(page);
    const padding = () => page.evaluate(() => (window as unknown as EditorHandle).__polishotApp.editor.doc.padding as number);
    const original = await padding();
    const slider = page.getByRole('slider', { name: 'Padding' });
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    const one = await padding();
    expect(one).toBeGreaterThan(original);
    await page.keyboard.press('Shift+ArrowRight');
    expect((await padding()) - one).toBeGreaterThan(one - original); // Shift moves further than a single nudge
    await slider.dblclick();
    expect(await padding()).toBeCloseTo(original, 3); // back to the auto-balance value
  });
});

test.describe('history grid', () => {
  test('groups captures under day headings and moves between cards with the arrow keys', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+h');
    await expect(page.locator('.pv-hcard').first()).toBeVisible();
    const headings = await page.locator('.pv-hgroup > .pv-group-title').allTextContents();
    expect(headings.slice(0, 2)).toEqual(['Today', 'Yesterday']);
    expect(new Set(headings).size).toBe(headings.length); // each heading once

    // One tab stop for the whole grid; the arrow keys move inside it.
    expect(await page.locator('.pv-hcard-open[tabindex="0"]').count()).toBe(1);
    const cards = page.locator('.pv-hcard-open');
    await cards.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(cards.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const afterDown = await page.evaluate(() => [...document.querySelectorAll('.pv-hcard-open')].indexOf(document.activeElement as Element));
    expect(afterDown).toBeGreaterThan(1);
    await page.keyboard.press('Home');
    await expect(cards.first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(cards.last()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-inspector')).toBeVisible(); // Enter opens it
  });

  test('Delete on a focused card removes it', async ({ page }) => {
    await ready(page, 'history=3');
    await page.keyboard.press('Control+h');
    await expect(page.locator('.pv-hcard')).toHaveCount(4);
    await page.locator('.pv-hcard-open').nth(1).focus();
    await page.keyboard.press('Delete');
    await expect(page.locator('.pv-hcard')).toHaveCount(3);
  });
});

test.describe('license screen', () => {
  const accentOf = (page: Page) =>
    page.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--ps-accent');
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });

  test('Free lists what it includes next to Pro; Buy Pro is the one accent button', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+l');
    await expect(page.getByText('Batch beautify, 5 images at a time')).toBeVisible();
    await expect(page.getByText('Up to 3 saved looks')).toBeVisible();
    const accent = await accentOf(page);
    const buy = page.getByRole('button', { name: 'Buy Pro' }).first();
    expect(await buy.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(accent);
    // Activate is quiet until there is a key to activate.
    const activate = page.getByRole('button', { name: 'Activate' });
    expect(await activate.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(accent);
    await page.getByLabel('License key').fill('PSHOT-AAAAAA-BBBBBB');
    await expect.poll(() => activate.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(accent); // after its colour transition
  });

  test('Pro shows what it includes, without the Free column', async ({ page }) => {
    await ready(page, 'lic=pro');
    await page.keyboard.press('Control+l');
    await expect(page.getByText('No watermark on exports')).toBeVisible();
    await expect(page.getByText('Up to 3 saved looks')).toHaveCount(0);
  });
});

test.describe('pin window', () => {
  test('shows the opacity and a close button, changes opacity with keys and wheel, and fades the controls', async ({ page }) => {
    await page.goto('/pin.html?id=abc123');
    const pill = page.getByRole('group', { name: 'Pin controls' });
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('100%');
    await page.keyboard.press('ArrowDown');
    await expect(pill).toContainText('95%');
    await page.mouse.move(300, 300);
    await page.mouse.wheel(0, 100);
    await expect(pill).toContainText('90%');
    await page.mouse.wheel(0, -100);
    await page.keyboard.press('ArrowUp');
    await expect(pill).toContainText('100%');
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown');
    await expect(pill).toContainText('20%'); // never fully invisible
    // The controls leave quietly once the pointer does, and come back with it.
    // The pointer leaves the window (the page cannot move the mouse outside the viewport, so say it directly).
    await page.locator('[data-tauri-drag-region]').dispatchEvent('pointerout', { relatedTarget: null });
    await expect.poll(() => pill.evaluate((el) => getComputedStyle(el).opacity), { timeout: 8000 }).toBe('0');
    await page.mouse.move(420, 320);
    await expect.poll(() => pill.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect(page.getByRole('button', { name: 'Close pin' })).toBeVisible();
  });
});
