import { expect, test, type Page } from '@playwright/test';
import type { Annotation, EditorDoc } from '../src/types';

const SHOTS = 'D:/polishot/packages/editor/test-results';

async function open(page: Page, theme: 'light' | 'dark' = 'light') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?theme=' + theme);
  await page.waitForFunction(() => window.__polishot?.editor.hasImage === true);
  return errors;
}

const getDoc = (page: Page) => page.evaluate(() => window.__polishot!.editor.doc) as Promise<EditorDoc>;
const tool = (page: Page) => page.evaluate(() => window.__polishot!.editor.tool);
const canUndo = (page: Page) => page.evaluate(() => window.__polishot!.editor.canUndo());
const annotations = async (page: Page) => (await getDoc(page)).annotations;
const frame = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** Browser-window coordinates of a point given in source-image pixels. */
async function screenOf(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ x, y }) => {
      const ed = window.__polishot!.editor;
      const r = ed.imageRectToScreen({ x, y, w: 0, h: 0 });
      const host = ed.element.getBoundingClientRect();
      return { x: host.left + r.x, y: host.top + r.y };
    },
    { x, y },
  );
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await screenOf(page, ...from);
  const b = await screenOf(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

/**
 * A hash of what the two Konva layers currently show (sampled on a coarse grid). It changes whenever the
 * background, frame, padding or size on screen changes, and is identical for identical pictures.
 */
const backdropPixel = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let h = 2166136261;
    const layers = [...window.__polishot!.editor.element.querySelectorAll('canvas')].slice(0, 2) as HTMLCanvasElement[];
    for (const c of layers) {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 29) h = Math.imul(h ^ d[i]!, 16777619) ^ d[i + 1]! ^ (d[i + 2]! << 8);
      h = Math.imul(h ^ c.width, 16777619) ^ c.height;
    }
    return String(h >>> 0);
  });

const focusCanvas = (page: Page) => page.locator('.pe-root').focus();

test.describe('interaction quality bar', () => {
  test('hovering previews a swatch without touching history; leaving restores; a click commits', async ({ page }) => {
    const errors = await open(page);
    const docBefore = JSON.stringify(await getDoc(page));
    const tiles = page.locator('.pe-tile');
    const swatch = tiles.nth(2);

    const before = await backdropPixel(page);
    await swatch.hover();
    await expect.poll(() => backdropPixel(page)).not.toBe(before);
    expect(await page.evaluate(() => window.__polishot!.editor.previewing)).toBe(true);
    // A preview is not a change: the document, the undo stack and exports stay on the committed look.
    expect(JSON.stringify(await getDoc(page))).toBe(docBefore);
    expect(await canUndo(page)).toBe(false);

    await page.mouse.move(5, 300);
    await expect.poll(() => backdropPixel(page)).toBe(before);
    expect(await page.evaluate(() => window.__polishot!.editor.previewing)).toBe(false);

    // Moving from swatch to swatch previews each in turn.
    await tiles.nth(2).hover();
    const first = await backdropPixel(page);
    await tiles.nth(3).hover();
    await expect.poll(() => backdropPixel(page)).not.toBe(first);

    // A click commits: one undo step, and no preview is left behind.
    await swatch.click();
    const doc = await getDoc(page);
    expect(doc.background.type).toBe('gradient');
    expect(await page.evaluate(() => window.__polishot!.editor.previewing)).toBe(false);
    expect(await canUndo(page)).toBe(true);
    await page.mouse.move(5, 300);
    expect((await getDoc(page)).background).toEqual(doc.background);
    await page.keyboard.press('Control+z');
    expect(JSON.stringify(await getDoc(page))).toBe(docBefore);
    expect(await canUndo(page)).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('hover also previews frames and saved looks; exporting while hovering uses the committed look', async ({ page }) => {
    await open(page);
    const size0 = await page.evaluate(() => window.__polishot!.editor.canvasSize);
    await page.getByRole('button', { name: 'Browser', exact: true }).hover();
    await expect.poll(() => page.evaluate(() => window.__polishot!.editor.canvasSize.height)).not.toBe(size0.height);
    // The canvas the user sees changed, but the committed document and the export did not.
    expect((await getDoc(page)).frame).toBe('none');
    const exported = await page.evaluate(async () => {
      const bmp = await createImageBitmap(await window.__polishot!.editor.export({ format: 'png', quality: 1, scale: 1, licensed: true }));
      return { w: bmp.width, h: bmp.height };
    });
    expect(exported).toEqual({ w: size0.width, h: size0.height });
    await page.mouse.move(5, 300);
    await expect.poll(() => page.evaluate(() => window.__polishot!.editor.canvasSize.height)).toBe(size0.height);

    // A saved look previews on hover too.
    await page.evaluate(() => {
      localStorage.setItem(
        'pe-playground-looks',
        JSON.stringify([
          { id: 'look-a', name: 'Wide', settings: { padding: 0.2, background: { type: 'solid', color: '#224466' }, radius: 24, shadow: 0.9, frame: 'window', preset: 'auto' } },
        ]),
      );
    });
    await page.reload();
    await page.waitForFunction(() => window.__polishot?.editor.hasImage === true);
    const before = await backdropPixel(page);
    await page.getByRole('button', { name: 'Wide', exact: true }).hover();
    await expect.poll(() => backdropPixel(page)).not.toBe(before);
    expect((await getDoc(page)).padding).not.toBe(0.2);
    await page.mouse.move(5, 300);
    await expect.poll(() => backdropPixel(page)).toBe(before);
  });

  test('hover preview respects reduced motion and renders within a frame on a 4K capture', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    // No animated transitions on the swatches, yet the preview still works.
    expect(await page.locator('.pe-tile').nth(1).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
    const before = await backdropPixel(page);
    await page.locator('.pe-tile').nth(2).hover();
    await expect.poll(() => backdropPixel(page)).not.toBe(before);
    await page.mouse.move(5, 300);

    await page.evaluate(() => window.__polishot!.loadSampleBitmap(3));
    const stats = await page.evaluate(() => {
      const ed = window.__polishot!.editor;
      const backgrounds = [
        { type: 'gradient', stops: ['#1d2b64', '#f8cdda'], angle: 160 },
        { type: 'gradient', stops: ['#134e5e', '#71b280'], angle: 160 },
        { type: 'solid', color: '#334455' },
      ] as const;
      const times: number[] = [];
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        ed.preview({ background: backgrounds[i % 3] as never });
        times.push(performance.now() - t0);
      }
      ed.clearPreview();
      times.sort((a, b) => a - b);
      return { median: times[30]!, p95: times[56]!, max: times[59]! };
    });
    console.log('preview on 4K: ' + JSON.stringify(stats));
    expect(stats.median).toBeLessThan(16);
    expect(stats.p95).toBeLessThan(16);
  });

  test('sliders: live while dragging, arrows nudge 1 (Shift 10), double-click resets, each gesture is one undo step', async ({ page }) => {
    await open(page);
    const slider = page.getByLabel('Padding');
    const readout = page.locator('.pe-field', { has: slider }).locator('output');
    const start = (await getDoc(page)).padding;
    const auto = await page.evaluate(() => window.__polishot!.editor.autoPadding);
    expect(start).toBeCloseTo(auto, 4);

    // Live: the document follows the pointer before the button is released.
    const box = (await slider.boundingBox())!;
    await page.mouse.move(box.x + box.width * (start / 0.3), box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 8 });
    const live = (await getDoc(page)).padding;
    expect(live).toBeGreaterThan(start + 0.05);
    await expect(readout).toHaveText(Math.round(live * 100) + '%');
    await page.mouse.up();
    await page.keyboard.press('Control+z');
    expect((await getDoc(page)).padding).toBeCloseTo(start, 3);
    expect(await canUndo(page)).toBe(false);

    // Arrow keys: 1 per press, 10 with Shift.
    await page.evaluate(() => window.__polishot!.editor.update({ padding: 0.1 }));
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    expect((await getDoc(page)).padding).toBeCloseTo(0.11, 4);
    await page.keyboard.press('Shift+ArrowRight');
    expect((await getDoc(page)).padding).toBeCloseTo(0.21, 4);
    await page.keyboard.press('ArrowLeft');
    expect((await getDoc(page)).padding).toBeCloseTo(0.2, 4);
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await getDoc(page)).padding).toBeCloseTo(0.1, 4);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    expect((await getDoc(page)).padding).toBeCloseTo(0.3, 4); // clamped at the slider's end
    await expect(readout).toHaveText('30%');

    // Holding a key is one undo step.
    await page.evaluate(() => window.__polishot!.editor.update({ padding: 0.05 }));
    await slider.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    expect((await getDoc(page)).padding).toBeCloseTo(0.11, 4);
    await page.keyboard.press('Control+z');
    expect((await getDoc(page)).padding).toBeCloseTo(0.05, 4);

    // Double-click resets to the default (Padding: what auto-balance suggested), as one step.
    await page.evaluate(() => window.__polishot!.editor.update({ padding: 0.15 }));
    await slider.dblclick({ position: { x: 0.5 * (await slider.boundingBox())!.width, y: 10 } });
    expect((await getDoc(page)).padding).toBeCloseTo(auto, 3);
    await page.keyboard.press('Control+z');
    expect((await getDoc(page)).padding).not.toBeCloseTo(auto, 3);

    for (const [label, value, reset] of [
      ['Corners', 30, 12],
      ['Shadow', 0.9, 0.5],
    ] as const) {
      const key = label === 'Corners' ? 'radius' : 'shadow';
      await page.evaluate(([k, v]) => window.__polishot!.editor.update({ [k]: v } as never), [key, value] as const);
      const s = page.getByLabel(label);
      const b = (await s.boundingBox())!;
      const max = label === 'Corners' ? 48 : 1;
      await s.dblclick({ position: { x: (value / max) * b.width, y: b.height / 2 } });
      expect(((await getDoc(page)) as unknown as Record<string, number>)[key], label).toBeCloseTo(reset, 3);
    }
  });

  test('arrow keys on a slider do not nudge the selected shape', async ({ page }) => {
    await open(page);
    await focusCanvas(page);
    await page.keyboard.press('r');
    await drag(page, [340, 520], [560, 600]);
    await page.keyboard.press('v');
    const rect0 = (await annotations(page)).find((a) => a.type === 'rect')! as Extract<Annotation, { type: 'rect' | 'ellipse' }>;
    const edge = await screenOf(page, rect0.x + rect0.w * 0.25, rect0.y);
    await page.mouse.click(edge.x, edge.y);
    expect(await page.evaluate(() => window.__polishot!.editor.selectedId)).toBe(rect0.id);

    await page.getByLabel('Padding').focus();
    const pad = (await getDoc(page)).padding;
    await page.keyboard.press('ArrowRight');
    const rect1 = (await annotations(page)).find((a) => a.type === 'rect')! as Extract<Annotation, { type: 'rect' | 'ellipse' }>;
    expect(rect1.x).toBe(rect0.x);
    expect((await getDoc(page)).padding).toBeCloseTo(pad + 0.01, 4);
  });

  test('Shift constrains: 45 degree lines and arrows, squares and circles', async ({ page }) => {
    const errors = await open(page);
    await focusCanvas(page);
    const angleOf = (a: Annotation) => {
      if (a.type !== 'arrow' && a.type !== 'line') throw new Error('not a line');
      return (Math.atan2(a.points[3] - a.points[1], a.points[2] - a.points[0]) * 180) / Math.PI;
    };

    // Without Shift the angle is whatever the hand did.
    await page.keyboard.press('a');
    await drag(page, [360, 300], [700, 380]);
    // With Shift it snaps to a multiple of 45 degrees.
    await page.keyboard.down('Shift');
    await drag(page, [360, 420], [700, 470]); // about 8 degrees -> 0
    await drag(page, [360, 520], [520, 700]); // about 48 degrees -> 45
    await page.keyboard.up('Shift');
    await page.keyboard.press('l');
    await page.keyboard.down('Shift');
    await drag(page, [800, 300], [860, 520]); // about 75 degrees -> 90
    await page.keyboard.up('Shift');

    const lines = (await annotations(page)).filter((a) => a.type === 'arrow' || a.type === 'line');
    expect(lines).toHaveLength(4);
    const free = angleOf(lines[0]!);
    expect(Math.abs(free / 45 - Math.round(free / 45))).toBeGreaterThan(0.05);
    for (const l of lines.slice(1)) {
      const a = angleOf(l);
      expect(Math.abs(a / 45 - Math.round(a / 45)), String(a)).toBeLessThan(1e-6);
    }
    expect(angleOf(lines[1]!)).toBeCloseTo(0, 6);
    expect(angleOf(lines[2]!)).toBeCloseTo(45, 6);
    expect(angleOf(lines[3]!)).toBeCloseTo(90, 6);

    await page.keyboard.press('r');
    await page.keyboard.down('Shift');
    await drag(page, [900, 120], [1020, 200]);
    await page.keyboard.up('Shift');
    await page.keyboard.press('e');
    await page.keyboard.down('Shift');
    await drag(page, [900, 300], [980, 420]);
    await page.keyboard.up('Shift');
    await page.keyboard.press('r');
    await drag(page, [900, 520], [1000, 580]); // free rectangle stays free
    const shapes = (await annotations(page)).filter((a): a is Extract<Annotation, { w: number }> => a.type === 'rect' || a.type === 'ellipse');
    expect(shapes.map((s) => s.type)).toEqual(['rect', 'ellipse', 'rect']);
    expect(shapes[0]!.w).toBeCloseTo(shapes[0]!.h, 6);
    expect(shapes[1]!.w).toBeCloseTo(shapes[1]!.h, 6);
    expect(Math.abs(shapes[2]!.w - shapes[2]!.h)).toBeGreaterThan(20);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the tool stays active after drawing; Esc and V return to Select', async ({ page }) => {
    await open(page);
    await focusCanvas(page);
    await page.keyboard.press('a');
    await drag(page, [360, 300], [520, 320]);
    expect(await tool(page)).toBe('arrow');
    await drag(page, [360, 360], [520, 380]);
    expect(await tool(page)).toBe('arrow');
    expect((await annotations(page)).filter((a) => a.type === 'arrow')).toHaveLength(2);
    await expect(page.getByRole('button', { name: 'Arrow' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    expect(await tool(page)).toBe('select');

    await page.keyboard.press('r');
    await drag(page, [600, 300], [700, 360]);
    await drag(page, [600, 400], [700, 460]);
    expect(await tool(page)).toBe('rect');
    await page.keyboard.press('v');
    expect(await tool(page)).toBe('select');
    // Step, blur and brush behave the same way.
    for (const key of ['n', 'b', 'p'] as const) {
      await page.keyboard.press(key);
      await drag(page, [800, 300], [880, 360]);
      expect(await tool(page), key).toBe({ n: 'step', b: 'blur', p: 'redact-brush' }[key]);
    }
  });

  test('text: click, type, click away commits; empty text is discarded; the tool stays', async ({ page }) => {
    const errors = await open(page);
    await focusCanvas(page);
    await page.keyboard.press('t');
    const field = page.locator('textarea.pe-text-input');

    const p1 = await screenOf(page, 700, 150);
    await page.mouse.click(p1.x, p1.y);
    await expect(field).toBeVisible();
    await field.fill('First note');
    const away = await screenOf(page, 900, 600);
    await page.mouse.click(away.x, away.y); // click away: commits, and only commits
    await expect(field).toHaveCount(0);
    let texts = (await annotations(page)).filter((a) => a.type === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: 'First note' });
    expect(await tool(page)).toBe('text');

    // Empty text is discarded, whichever way the field is left.
    await page.mouse.click(p1.x, p1.y + 60);
    await expect(field).toBeVisible();
    await page.mouse.click(away.x, away.y);
    await expect(field).toHaveCount(0);
    await page.mouse.click(p1.x, p1.y + 60);
    await field.fill('   ');
    await field.press('Control+Enter');
    await expect(field).toHaveCount(0);
    texts = (await annotations(page)).filter((a) => a.type === 'text');
    expect(texts).toHaveLength(1);
    expect(await tool(page)).toBe('text');

    // Editing an existing note down to nothing deletes it.
    await page.keyboard.press('v');
    const at = await screenOf(page, 700 + 10, 150 + 10);
    await page.mouse.dblclick(at.x, at.y);
    await expect(field).toBeVisible();
    await field.fill('');
    await field.press('Control+Enter');
    expect((await annotations(page)).filter((a) => a.type === 'text')).toHaveLength(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('selection: arrows nudge 1 px (Shift 10), a held key is one undo step, Ctrl+D duplicates, empty canvas deselects', async ({ page }) => {
    const errors = await open(page);
    await focusCanvas(page);
    await page.keyboard.press('r');
    await drag(page, [340, 520], [560, 600]);
    await page.keyboard.press('v');
    const rectOf = async () => (await annotations(page)).find((a) => a.type === 'rect')! as Extract<Annotation, { type: 'rect' | 'ellipse' }>;
    const r0 = await rectOf();
    const edge = await screenOf(page, r0.x + r0.w * 0.25, r0.y);
    await page.mouse.click(edge.x, edge.y);
    expect(await page.evaluate(() => window.__polishot!.editor.selectedId)).toBe(r0.id);

    await page.keyboard.press('ArrowRight');
    expect((await rectOf()).x).toBeCloseTo(r0.x + 1, 6);
    await page.keyboard.press('Shift+ArrowDown');
    expect((await rectOf()).y).toBeCloseTo(r0.y + 10, 6);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    expect(await rectOf()).toMatchObject({ x: r0.x, y: r0.y + 9 });
    await page.keyboard.press('Control+z'); // each press is its own step
    expect(await rectOf()).toMatchObject({ x: r0.x, y: r0.y + 10 });
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(await rectOf()).toMatchObject({ x: r0.x, y: r0.y });

    // Holding the key repeats; the whole hold is one undo step.
    await page.evaluate((id) => window.__polishot!.editor.select(id), r0.id);
    for (let i = 0; i < 5; i++) await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    expect((await rectOf()).x).toBeCloseTo(r0.x + 5, 6);
    await page.keyboard.press('Control+z');
    expect((await rectOf()).x).toBeCloseTo(r0.x, 6);
    await page.keyboard.press('Control+Shift+z');
    expect((await rectOf()).x).toBeCloseTo(r0.x + 5, 6);

    // Ctrl+D: a copy, offset, selected; one undo step; the original stays put.
    const before = await rectOf();
    await page.keyboard.press('Control+d');
    const rects = (await annotations(page)).filter((a) => a.type === 'rect');
    expect(rects).toHaveLength(2);
    const copy = rects.find((a) => a.id !== before.id)! as Extract<Annotation, { type: 'rect' | 'ellipse' }>;
    expect(copy.x).toBeGreaterThan(before.x);
    expect(copy.y).toBeGreaterThan(before.y);
    expect(copy).toMatchObject({ w: before.w, h: before.h, color: before.color });
    expect(await page.evaluate(() => window.__polishot!.editor.selectedId)).toBe(copy.id);
    expect((await rectOf()).x).toBeCloseTo(before.x, 6);
    await page.keyboard.press('Control+z');
    expect((await annotations(page)).filter((a) => a.type === 'rect')).toHaveLength(1);

    // Clicking empty canvas (the padding area) deselects.
    await page.evaluate((id) => window.__polishot!.editor.select(id), before.id);
    const empty = await page.evaluate(() => {
      const ed = window.__polishot!.editor;
      const host = ed.element.getBoundingClientRect();
      return { x: host.left + ed.contentRectOnScreen().x * 0.4, y: host.top + 60 };
    });
    await page.mouse.click(empty.x, empty.y);
    expect(await page.evaluate(() => window.__polishot!.editor.selectedId)).toBeNull();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('numbered steps renumber when one is deleted, as one undo step', async ({ page }) => {
    const errors = await open(page);
    await focusCanvas(page);
    await page.keyboard.press('n');
    const spots: [number, number][] = [
      [330, 120],
      [330, 220],
      [330, 320],
    ];
    for (const [x, y] of spots) {
      const p = await screenOf(page, x, y);
      await page.mouse.click(p.x, p.y);
    }
    const steps = async () =>
      (await annotations(page)).flatMap((a) => (a.type === 'step' ? [{ id: a.id, n: a.n }] : []));
    const original = await steps();
    expect(original.map((s) => s.n)).toEqual([1, 2, 3]);

    await page.keyboard.press('v');
    const first = await screenOf(page, spots[0]![0], spots[0]![1]);
    await page.mouse.click(first.x, first.y);
    expect(await page.evaluate(() => window.__polishot!.editor.selectedId)).toBe(original[0]!.id);
    await page.keyboard.press('Delete');
    const after = await steps();
    expect(after.map((s) => s.id)).toEqual([original[1]!.id, original[2]!.id]);
    expect(after.map((s) => s.n)).toEqual([1, 2]); // the second is now the first
    // The next new step continues from there.
    await page.keyboard.press('n');
    const p = await screenOf(page, 330, 420);
    await page.mouse.click(p.x, p.y);
    expect((await steps()).map((s) => s.n)).toEqual([1, 2, 3]);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect((await steps()).map((s) => [s.id, s.n])).toEqual(original.map((s) => [s.id, s.n]));
    await page.keyboard.press('Control+Shift+z');
    expect((await steps()).map((s) => s.n)).toEqual([1, 2]);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('no flash: the first visible frame is already the finished one', async ({ page }) => {
    await open(page);

    // 1. Reload the sample while sampling every frame: all visible frames are identical and styled.
    const loaded = await page.evaluate(async () => {
      const api = window.__polishot!;
      const ed = api.editor;
      const stage = ed.element.querySelector('.pe-stage') as HTMLElement;
      const sig = () => {
        const canvases = [...ed.element.querySelectorAll('canvas')].slice(0, 2) as HTMLCanvasElement[];
        let h = 2166136261;
        for (const c of canvases) {
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 97) h = Math.imul(h ^ d[i]!, 16777619);
          h = Math.imul(h ^ c.width, 16777619) ^ c.height;
        }
        return String(h >>> 0);
      };
      api.loadSample(1);
      const frames: { visible: boolean; sig: string }[] = [];
      // Frame 0 is sampled synchronously, i.e. before the browser could paint anything.
      frames.push({ visible: stage.style.visibility !== 'hidden', sig: sig() });
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        frames.push({ visible: stage.style.visibility !== 'hidden', sig: sig() });
      }
      const d = ed.doc;
      return { frames, styled: d.padding > 0 && d.radius > 0 && d.shadow > 0 && d.background.type === 'auto' && !!(d.background as { stops?: unknown }).stops && d.crop !== null };
    });
    expect(loaded.styled).toBe(true);
    expect(loaded.frames[0]!.visible).toBe(true);
    const visible = loaded.frames.filter((f) => f.visible);
    expect(new Set(visible.map((f) => f.sig)).size).toBe(1);

    // 2. A saved document with an image background stays hidden until the image is ready, then shows it fully.
    const image = await page.evaluate(async () => {
      const api = window.__polishot!;
      const ed = api.editor;
      const stage = ed.element.querySelector('.pe-stage') as HTMLElement;
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#cc3322';
      ctx.fillRect(0, 0, 32, 32);
      const src = c.toDataURL('image/png');
      const doc = { ...ed.doc, background: { type: 'image', src, blur: 0 }, padding: 0.2 } as unknown as typeof ed.doc;
      ed.load(api.image!, doc);
      // A pixel in the padding band, left of the picture: it must already show the background image.
      const corner = () => {
        const bg = ed.element.querySelectorAll('canvas')[0] as HTMLCanvasElement;
        const c = ed.contentRectOnScreen();
        const d = bg.getContext('2d')!.getImageData(Math.max(1, Math.floor(c.x - 8)), Math.floor(c.y + 12), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      const frames: { visible: boolean; corner: number[] }[] = [];
      frames.push({ visible: stage.style.visibility !== 'hidden', corner: corner() as number[] });
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        frames.push({ visible: stage.style.visibility !== 'hidden', corner: corner() as number[] });
      }
      return frames;
    });
    // Whenever the canvas is visible its background is already the picture (never an empty frame first).
    for (const f of image.filter((x) => x.visible)) expect(f.corner[0]).toBeGreaterThan(150);
    expect(image[image.length - 1]!.visible).toBe(true);

    // 3. An editor that loads before it is attached (no size yet) stays hidden, then shows the final layout.
    const late = await page.evaluate(async () => {
      const api = window.__polishot!;
      const holder = document.createElement('div');
      const ed = new api.EditorClass(holder, { licensed: false });
      ed.load(api.image!);
      const stage = ed.element.querySelector('.pe-stage') as HTMLElement;
      const hiddenWhileDetached = stage.style.visibility === 'hidden';
      const host = document.createElement('div');
      Object.assign(host.style, { position: 'fixed', left: '0', top: '0', width: '900px', height: '600px', zIndex: '-1' });
      document.body.appendChild(host);
      host.appendChild(ed.element);
      const seen: { visible: boolean; w: number; z: number }[] = [];
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        seen.push({ visible: stage.style.visibility !== 'hidden', w: ed.canvasSize.width, z: Math.round(ed.zoom * 1000) });
      }
      ed.destroy();
      host.remove();
      return { hiddenWhileDetached, seen };
    });
    expect(late.hiddenWhileDetached).toBe(true);
    const shown = late.seen.filter((s) => s.visible);
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown.map((s) => s.z)).size).toBe(1); // no re-layout after it appeared
  });

  test('acceptance flow: hover then click a background, drag padding, Shift arrow, two steps, delete the first, redact, undo x3, redo, copy', async ({ page }) => {
    const errors = await open(page);
    const shot = (name: string) => page.screenshot({ path: SHOTS + '/ux-' + name + '.png' });
    await shot('1-open');

    // Hover shows it, click commits it.
    await page.locator('.pe-tile').nth(3).hover();
    await expect.poll(() => page.evaluate(() => window.__polishot!.editor.previewing)).toBe(true);
    await shot('2-hover-background');
    await page.locator('.pe-tile').nth(3).click();
    await page.mouse.move(5, 300);
    await shot('3-background-committed');

    // Drag padding.
    const slider = page.getByLabel('Padding');
    const box = (await slider.boundingBox())!;
    const pad0 = (await getDoc(page)).padding;
    await page.mouse.move(box.x + box.width * (pad0 / 0.3), box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await shot('4-padding');

    // Arrow with Shift.
    await focusCanvas(page);
    await page.keyboard.press('a');
    await page.keyboard.down('Shift');
    await drag(page, [360, 300], [700, 345]);
    await page.keyboard.up('Shift');
    await shot('5-arrow');

    // Two numbered steps, delete the first.
    await page.keyboard.press('n');
    for (const [x, y] of [
      [330, 120],
      [330, 180],
    ] as const) {
      const p = await screenOf(page, x, y);
      await page.mouse.click(p.x, p.y);
    }
    await page.keyboard.press('v');
    const s1 = await screenOf(page, 330, 120);
    await page.mouse.click(s1.x, s1.y);
    await shot('6-step-selected');
    await page.keyboard.press('Delete');
    const stepsLeft = (await annotations(page)).filter((a) => a.type === 'step');
    expect(stepsLeft.map((s) => (s.type === 'step' ? s.n : 0))).toEqual([1]);
    await shot('7-step-renumbered');

    // Apply the detected redactions.
    await page.getByRole('button', { name: 'Find sensitive data' }).click();
    await expect(page.getByText('4 found')).toBeVisible();
    await page.getByRole('button', { name: 'Blur all' }).click();
    await expect(page.getByText('4 of 4 hidden')).toBeVisible();
    await shot('8-redacted');

    // Undo three times, redo once.
    const counts = async () => {
      const a = await annotations(page);
      return { blur: a.filter((x) => x.type === 'blur').length, step: a.filter((x) => x.type === 'step').length, arrow: a.filter((x) => x.type === 'arrow').length };
    };
    expect(await counts()).toEqual({ blur: 4, step: 1, arrow: 1 });
    await page.keyboard.press('Control+z'); // redactions
    expect(await counts()).toEqual({ blur: 0, step: 1, arrow: 1 });
    await page.keyboard.press('Control+z'); // step delete: both steps again
    expect(await counts()).toEqual({ blur: 0, step: 2, arrow: 1 });
    await page.keyboard.press('Control+z'); // second step
    expect(await counts()).toEqual({ blur: 0, step: 1, arrow: 1 });
    await shot('9-undo-x3');
    await page.keyboard.press('Control+Shift+z');
    expect(await counts()).toEqual({ blur: 0, step: 2, arrow: 1 });
    await shot('10-redo');

    // Copy: PNG at 2x, fast.
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Copy image' }).click();
    await page.waitForFunction(() => window.__polishot!.lastExport !== null);
    const ms = Date.now() - t0;
    const copied = await page.evaluate(() => ({ action: window.__polishot!.lastExport!.action, type: window.__polishot!.lastExport!.blob.type }));
    expect(copied).toEqual({ action: 'copy', type: 'image/png' });
    console.log('copy at 2x: ' + ms + ' ms');
    expect(ms).toBeLessThan(1500);
    await shot('11-copied');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
