import { expect, test, type Page } from '@playwright/test';

/**
 * "Fast app, no glitch" (owner priority), checked against the mock backend: dragging costs no frames because of the
 * recognised text, screens and tabs switch without rebuilding or shifting anything, the Copy image is only prepared
 * when the user has stopped, the backend is told when the styled image is on screen, the in-app capture does not
 * sleep, and the bundled faces are in place before the first paint.
 */

type EditorHandle = { __polishotApp: { editor: any } };
interface MockLast {
  windowCalls: string[];
  captureStarts: string[];
  hideAt?: number;
  captureStartAt?: number;
  previewReady: Array<{ id: string; editorHasImage: boolean; editorImageId: string }>;
}
const last = (page: Page) => page.evaluate<MockLast>(() => (window as unknown as { __polishotMock: { last: MockLast } }).__polishotMock.last);

async function ready(page: Page, query = '') {
  await page.goto(`/?mock=1&theme=light&delay=0${query ? `&${query}` : ''}`);
  await expect(page.locator('.pv-inspector')).toBeVisible();
  await expect(page.locator('.pe-canvas canvas').first()).toBeVisible();
  await page.waitForTimeout(1500); // the dev server finishes loading modules; the first capture pays for that
}

/** Frame intervals (ms) while the Padding slider is dragged across a third of its track. */
async function dragFrames(page: Page): Promise<{ median: number; p95: number }> {
  const box = (await page.getByRole('slider', { name: 'Padding' }).boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __raf: number };
    w.__frames = [];
    let prev = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - prev);
      prev = t;
      w.__raf = requestAnimationFrame(tick);
    };
    w.__raf = requestAnimationFrame(tick);
  });
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(box.x + box.width * (0.2 + i * 0.01), box.y + box.height / 2);
    await page.waitForTimeout(6);
  }
  await page.mouse.up();
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __raf: number };
    cancelAnimationFrame(w.__raf);
    const f = w.__frames.slice(2).sort((a, b) => a - b);
    return { median: f[Math.floor(f.length / 2)]!, p95: f[Math.floor(f.length * 0.95)]! };
  });
}

test.describe('dragging', () => {
  test('recognised text costs no frames: a screenful of words drags like a screenshot without any', async ({ page }) => {
    await ready(page, 'ocr=none');
    const bare = await dragFrames(page);
    await ready(page, 'ocr=many'); // about 600 words
    const heavy = await dragFrames(page);
    console.log(`padding drag p95 frame: no text ${bare.p95.toFixed(0)} ms, 600 words ${heavy.p95.toFixed(0)} ms`);
    // The editor package's own text layer cost about 80 ms per frame here; this must stay within noise of "no text".
    expect(heavy.p95).toBeLessThanOrEqual(bare.p95 * 2 + 20);
  });
});

test.describe('text layer choice', () => {
  // Opt-in (POLISHOT_COMPARE_TEXTLAYER=1): when the editor package ships a faster TextLayer, run this to see which of
  // the two drags better and keep that one. It only reports; nothing is asserted.
  test.skip(!process.env.POLISHOT_COMPARE_TEXTLAYER, 'comparison only');

  test('package TextLayer against the host TextOverlay, 600 words', async ({ page }) => {
    await ready(page, 'ocr=many');
    const host = await dragFrames(page);
    await ready(page, 'ocr=many&textlayer=package');
    const pkg = await dragFrames(page);
    console.log(`padding drag, 600 words: host TextOverlay p95 ${host.p95.toFixed(0)} ms (median ${host.median.toFixed(1)}); package TextLayer p95 ${pkg.p95.toFixed(0)} ms (median ${pkg.median.toFixed(1)})`);
  });
});

test.describe('screens and tabs', () => {
  test('the editor is not rebuilt when a screen is opened and closed', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => {
      const canvas = document.querySelector('.pe-canvas canvas');
      canvas?.setAttribute('data-probe', 'same-node');
      (window as unknown as { __canvas: Element | null }).__canvas = canvas;
    });
    for (const key of ['Control+h', 'Control+,', 'Control+l']) {
      await page.keyboard.press(key);
      await expect(page.locator('.pv-layer-over')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.pv-inspector')).toBeVisible();
    }
    const same = await page.evaluate(() => document.querySelector('.pe-canvas canvas') === (window as unknown as { __canvas: Element | null }).__canvas);
    expect(same, 'the canvas element is the same one').toBe(true);
    // Hidden, the editor is out of the tab order and the accessibility tree while another screen is shown.
    await page.keyboard.press('Control+h');
    await expect(page.getByRole('tab', { name: 'Style' })).toHaveCount(0);
    await expect(page.locator('.pv-layer[data-active="false"]')).toHaveCount(1);
  });

  test('opening and leaving a screen shifts nothing', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => {
      const w = window as unknown as { __shifts: number };
      w.__shifts = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__shifts += e.value;
      }).observe({ type: 'layout-shift', buffered: false });
    });
    for (const key of ['Control+h', 'Control+,', 'Control+l', 'Control+3', 'Control+2', 'Control+4', 'Control+1']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(120);
      if (['Control+h', 'Control+,', 'Control+l'].includes(key)) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
      }
    }
    expect(await page.evaluate(() => (window as unknown as { __shifts: number }).__shifts)).toBeLessThan(0.005);
  });

  test('the search box does not move when the first capture opens', async ({ page }) => {
    await page.goto('/?mock=1&theme=light&capture=0');
    await expect(page.locator('.pv-empty')).toBeVisible();
    await page.waitForTimeout(800);
    const before = await page.locator('.pv-cmdbtn').boundingBox();
    await page.evaluate(() => (window as unknown as { __polishotMock: { newCapture: () => void } }).__polishotMock.newCapture());
    await expect(page.locator('.pv-inspector')).toBeVisible();
    const after = await page.locator('.pv-cmdbtn').boundingBox();
    expect(Math.abs(after!.x - before!.x)).toBeLessThan(0.5);
    expect(Math.abs(after!.width - before!.width)).toBeLessThan(0.5);
  });

  test('inspector panels stay built: coming back to a tab keeps its scroll position', async ({ page }) => {
    await ready(page);
    const body = page.locator('#pv-insp-panel-style');
    await body.evaluate((el) => (el.scrollTop = 240));
    const before = await body.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(100);
    await page.keyboard.press('Control+3');
    await expect(page.getByRole('tab', { name: 'Text', selected: true })).toBeVisible();
    await page.keyboard.press('Control+1');
    await expect(page.getByRole('tab', { name: 'Style', selected: true })).toBeVisible();
    expect(await body.evaluate((el) => el.scrollTop)).toBe(before);
    // Only the opened panels exist: nothing is built behind the user's back.
    expect(await page.locator('[role="tabpanel"]').count()).toBe(2);
  });
});

test.describe('copy image preparation', () => {
  test('does not start while the user is still working, and does once they stop', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => {
      const ed = (window as unknown as EditorHandle).__polishotApp.editor;
      const w = window as unknown as { __exports: number[] };
      w.__exports = [];
      const original = ed.export.bind(ed);
      ed.export = (...args: unknown[]) => {
        w.__exports.push(performance.now());
        return original(...args);
      };
    });
    // One edit, then the user keeps working without changing anything else (looking, pointing, scrolling). Without
    // the gate the image would be rendered about 0.7 s after the edit, right in the middle of this.
    const slider = page.getByRole('slider', { name: 'Padding' });
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 16; i++) {
      await page.mouse.move(120 + (i % 2) * 200, 300 + i * 4);
      await page.waitForTimeout(200);
    }
    expect(await page.evaluate(() => (window as unknown as { __exports: number[] }).__exports.length), 'no render during activity').toBe(0);
    // Hands off: the image is prepared within the quiet spell plus an idle slot.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __exports: number[] }).__exports.length), { timeout: 8000 })
      .toBeGreaterThanOrEqual(1);
  });
});

test.describe('the window and the backend', () => {
  test('tells the backend once the styled image is on screen, not before', async ({ page }) => {
    await ready(page);
    const calls = (await last(page)).previewReady;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const first = calls[0]!;
    expect(first.editorHasImage).toBe(true);
    expect(first.editorImageId).toBe(first.id); // the editor already held this very image
    // A second capture announces itself the same way.
    await page.evaluate(() => (window as unknown as { __polishotMock: { newCapture: () => void } }).__polishotMock.newCapture());
    await expect.poll(async () => (await last(page)).previewReady.length).toBe(calls.length + 1);
    const second = (await last(page)).previewReady.at(-1)!;
    expect(second.editorImageId).toBe(second.id);
    expect(second.id).not.toBe(first.id);
  });

  test('an in-app capture waits for the window to be hidden, not for a fixed sleep', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+n');
    await expect.poll(async () => (await last(page)).captureStarts, { timeout: 5000 }).toContain('region');
    const l = await last(page);
    const gap = l.captureStartAt! - l.hideAt!;
    console.log(`hide -> capture_start: ${gap.toFixed(0)} ms (was a fixed 220+)`);
    expect(gap).toBeGreaterThan(40); // it did wait for the hidden event and a compositor beat
    expect(gap).toBeLessThan(200);
  });
});

test.describe('type', () => {
  test('the site faces are loaded before the first paint, and the headings use the serif', async ({ page }) => {
    await page.goto('/?mock=1&theme=light&delay=0');
    await expect(page.locator('.pv-inspector')).toBeVisible();
    const fonts = await page.evaluate(async () => ({
      sans: document.fonts.check('13px "Polishot Sans"') && [...document.fonts].some((f) => f.family.includes('Polishot Sans') && f.status === 'loaded'),
      serif: [...document.fonts].some((f) => f.family.includes('Polishot Serif') && f.status === 'loaded'),
      body: getComputedStyle(document.body).fontFamily,
    }));
    expect(fonts.sans).toBe(true);
    expect(fonts.body).toMatch(/^"?Polishot Sans/);
    await page.keyboard.press('Control+h');
    const heading = page.getByRole('heading', { name: 'History', level: 1 });
    await expect(heading).toBeVisible();
    expect(await heading.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Polishot Serif/);
    expect(await page.evaluate(() => [...document.fonts].some((f) => f.family.includes('Polishot Serif') && f.status === 'loaded'))).toBe(true);
  });
});
