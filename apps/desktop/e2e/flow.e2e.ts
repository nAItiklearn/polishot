import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The acceptance flow from docs/UX-BAR.md, run against the mock backend:
 * open a capture, change the background (hover, then click), drag padding, draw an arrow with Shift,
 * add two numbered steps, delete the first (the second renumbers), apply the detected redactions,
 * undo three times, redo, copy. Screenshots of each step go to e2e/screenshots/flow-*.png.
 */
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `flow-${name}.png`) });

interface Probe {
  annotations: Array<{ type: string; n?: number; points?: number[]; mode?: string }>;
  padding: number;
  background: string;
  canUndo: boolean;
  canRedo: boolean;
  previewing: boolean;
}

const probe = (page: Page) =>
  page.evaluate<Probe>(() => {
    const ed = (window as unknown as { __polishotApp: { editor: any } }).__polishotApp.editor;
    return {
      annotations: ed.doc.annotations,
      padding: ed.doc.padding,
      background: JSON.stringify(ed.doc.background),
      canUndo: ed.canUndo(),
      canRedo: ed.canRedo(),
      previewing: ed.previewing === true,
    };
  });

/** Where the screenshot sits on the page, in CSS pixels. */
async function contentBox(page: Page) {
  return page.evaluate(() => {
    const ed = (window as unknown as { __polishotApp: { editor: any } }).__polishotApp.editor;
    const r = ed.contentRectOnScreen();
    const host = ed.element.getBoundingClientRect();
    return { x: host.x + r.x, y: host.y + r.y, w: r.w, h: r.h };
  });
}

test('acceptance flow: capture to copied', async ({ page }) => {
  const log: string[] = [];
  page.on('console', (m) => {
    if (m.text().startsWith('[preview]')) log.push(m.text());
  });

  await page.goto('/?mock=1&theme=light&delay=0');
  await expect(page.locator('.pv-inspector')).toBeVisible();
  await expect(page.locator('.pv-found')).toBeVisible();
  await shot(page, '01-opened');

  // 1. Background: hover previews, click commits.
  const before = await probe(page);
  const swatch = page.locator('.pe-tiles .pe-tile').nth(3);
  await swatch.hover();
  await page.waitForTimeout(80);
  const hovering = await probe(page);
  expect(hovering.previewing, 'hovering a swatch previews it on the canvas').toBe(true);
  expect(hovering.background, 'a preview never touches the document').toBe(before.background);
  await shot(page, '02-hover-swatch');
  await swatch.click();
  await page.waitForTimeout(80);
  const clicked = await probe(page);
  expect(clicked.background).not.toBe(before.background);
  expect(clicked.previewing).toBe(false);
  await page.mouse.move(600, 600);
  await shot(page, '03-swatch-applied');

  // 2. Padding slider: one drag, one undo step.
  const slider = page.getByRole('slider', { name: 'Padding' });
  const sb = (await slider.boundingBox())!;
  await page.mouse.move(sb.x + sb.width * 0.3, sb.y + sb.height / 2);
  await page.mouse.down();
  const seen = new Set<number>();
  for (let i = 0; i <= 10; i++) {
    await page.mouse.move(sb.x + sb.width * (0.3 + i * 0.045), sb.y + sb.height / 2);
    seen.add((await probe(page)).padding);
  }
  await page.mouse.up();
  const afterDrag = await probe(page);
  expect(afterDrag.padding).not.toBe(clicked.padding);
  expect(seen.size).toBeGreaterThan(3); // it updated while dragging, not just on release
  await shot(page, '04-padding-dragged');

  // 3. Arrow with Shift: the angle snaps to a multiple of 45 degrees.
  await page.keyboard.press('a');
  const box = await contentBox(page);
  const ax = box.x + box.w * 0.55;
  const ay = box.y + box.h * 0.72;
  await page.mouse.move(ax, ay);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(ax + 120, ay + 53, { steps: 6 }); // roughly 24 degrees: should snap to 0 or 45
  await shot(page, '05-arrow-while-drawing');
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const withArrow = await probe(page);
  const arrow = withArrow.annotations.find((a) => a.type === 'arrow');
  expect(arrow, 'an arrow was drawn').toBeTruthy();
  const [x1, y1, x2, y2] = arrow!.points!;
  const dx = Math.abs(x2! - x1!);
  const dy = Math.abs(y2! - y1!);
  const snapped = dy < 0.5 || dx < 0.5 || Math.abs(dx - dy) < 0.5;
  expect(snapped, `arrow ${dx.toFixed(1)} x ${dy.toFixed(1)} is a multiple of 45 degrees`).toBe(true);
  await shot(page, '06-arrow-drawn');

  // 4. Two numbered steps; the tool stays active between clicks.
  await page.keyboard.press('n');
  await page.mouse.click(box.x + box.w * 0.3, box.y + box.h * 0.35);
  await page.mouse.click(box.x + box.w * 0.45, box.y + box.h * 0.35);
  const twoSteps = await probe(page);
  expect(twoSteps.annotations.filter((a) => a.type === 'step').map((a) => a.n)).toEqual([1, 2]);
  await shot(page, '07-two-steps');

  // 5. Delete the first: the second becomes 1.
  await page.keyboard.press('v');
  await page.mouse.click(box.x + box.w * 0.3, box.y + box.h * 0.35);
  await page.keyboard.press('Delete');
  const afterDelete = await probe(page);
  expect(afterDelete.annotations.filter((a) => a.type === 'step').map((a) => a.n)).toEqual([1]);
  await shot(page, '08-first-step-deleted');

  // 6. Redactions in one click.
  await page.getByRole('button', { name: 'Hide' }).click();
  const redacted = await probe(page);
  expect(redacted.annotations.filter((a) => a.type === 'blur').length).toBeGreaterThanOrEqual(4);
  await expect(page.locator('.pv-found')).toHaveCount(0);
  await shot(page, '09-redacted');

  // 7. Undo three times, redo once.
  await page.mouse.move(600, 620);
  const counts: number[] = [redacted.annotations.length];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+z');
    counts.push((await probe(page)).annotations.length);
  }
  expect(counts[1]).toBeLessThan(counts[0]!); // the first undo took the redactions back
  await shot(page, '10-undone-three-times');
  await page.keyboard.press('Control+Shift+z');
  const redone = await probe(page);
  expect(redone.annotations.length).toBeGreaterThanOrEqual(counts[3]!);
  await shot(page, '11-redone');

  // 8. Copy. Right after editing nothing is prepared yet (cold); after a pause it is instant (warm).
  const t0 = Date.now();
  await page.keyboard.press('Control+c');
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  const coldToastMs = Date.now() - t0;
  const cold = await lastCopyMs(page);
  await shot(page, '12-copied');

  await page.keyboard.press('Control+z'); // an edit, so the prepared image is stale again
  await page.waitForTimeout(3200); // the quiet moment in which Copy is prepared
  const t1 = Date.now();
  await page.keyboard.press('Control+c');
  await expect(page.getByRole('status').filter({ hasText: 'Copied' }).last()).toBeVisible();
  const warmToastMs = Date.now() - t1;
  const warm = await lastCopyMs(page);

  const result = await page.evaluate(() => ({
    bytes: (window as unknown as { __polishotMock: { last: { copiedImageBytes?: number } } }).__polishotMock.last.copiedImageBytes ?? 0,
    paint: (window as unknown as { __polishotTiming?: Array<{ totalMs: number }> }).__polishotTiming?.[0]?.totalMs ?? -1,
  }));
  expect(result.bytes).toBeGreaterThan(1000);
  console.log(`hover preview active while hovering a swatch: ${hovering.previewing}`);
  console.log(`event-to-first-paint ${result.paint.toFixed(0)} ms`);
  console.log(`copy cold: ${cold.toFixed(0)} ms (keypress to toast ${coldToastMs} ms); copy warm: ${warm.toFixed(0)} ms (keypress to toast ${warmToastMs} ms)`);
  console.log(log.join(String.fromCharCode(10)));
  expect(warm).toBeLessThan(300);
});

async function lastCopyMs(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __polishotLastExportMs?: { copy?: number } }).__polishotLastExportMs?.copy ?? -1);
}

test('copy on a 4K capture: cold and warm', async ({ page }) => {
  await page.goto('/?mock=1&theme=light&delay=0&size=4k');
  await expect(page.locator('.pv-inspector')).toBeVisible();
  const paint = await page.evaluate(() => (window as unknown as { __polishotTiming?: Array<{ totalMs: number }> }).__polishotTiming?.[0]?.totalMs ?? -1);
  await page.keyboard.press('Control+c'); // straight away: nothing prepared
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  const cold = await lastCopyMs(page);
  await page.keyboard.press('Control+z'); // no-op edit target: the document is unchanged, so the first render is reused
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+c');
  await expect(page.getByRole('status').filter({ hasText: 'Copied' }).last()).toBeVisible();
  const second = await lastCopyMs(page);
  console.log(`4K: event-to-first-paint ${paint.toFixed(0)} ms; copy cold ${cold.toFixed(0)} ms; copy again (prepared) ${second.toFixed(0)} ms`);
  expect(cold).toBeGreaterThan(0);
  expect(second).toBeLessThan(300);
});

test('event to first paint, steady state', async ({ page }) => {
  await page.goto('/?mock=1&theme=light&delay=0');
  await expect(page.locator('.pv-inspector')).toBeVisible();
  await page.waitForTimeout(1500); // let the dev server finish loading modules: the first capture pays for that
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const before = await page.evaluate(() => (window as unknown as { __polishotTiming?: unknown[] }).__polishotTiming?.length ?? 0);
    await page.evaluate(() => (window as unknown as { __polishotMock: { newCapture: () => void } }).__polishotMock.newCapture());
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __polishotTiming?: unknown[] }).__polishotTiming?.length ?? 0), { timeout: 15_000 })
      .toBeGreaterThan(before);
    runs.push(await page.evaluate(() => (window as unknown as { __polishotTiming: Array<{ totalMs: number }> }).__polishotTiming.at(-1)!.totalMs));
    await page.waitForTimeout(400);
  }
  const sorted = [...runs].sort((a, b) => a - b);
  console.log(`capture:ready to first paint (dev build, headless, 1280x800): ${runs.map((r) => r.toFixed(0)).join(', ')} ms; median ${sorted[2]!.toFixed(0)} ms`);
  expect(sorted[2]!).toBeLessThan(500);
});
