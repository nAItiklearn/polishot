import { expect, test, type Page } from '@playwright/test';
import { computeLayout } from '../src/layout';
import type { Annotation, EditorDoc } from '../src/types';
import { SAMPLE_TEXT } from '../playground/sample';

const SHOTS = 'D:/polishot/packages/editor/test-results';

async function open(page: Page, theme: 'light' | 'dark' = 'light') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/?theme=${theme}`);
  await page.waitForFunction(() => window.__polishot?.editor.hasImage === true);
  return errors;
}

const getDoc = (page: Page) => page.evaluate(() => window.__polishot!.editor.doc) as Promise<EditorDoc>;

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

/** Mean absolute horizontal gradient of the exported image inside a source-image box (a "sharpness" score). */
async function sharpness(page: Page, box: { x: number; y: number; w: number; h: number }) {
  return page.evaluate(async (b) => {
    const ed = window.__polishot!.editor;
    const blob = await ed.export({ format: 'png', quality: 1, scale: 1, licensed: true });
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const tl = ed.imageRectToScreen({ x: b.x, y: b.y, w: b.w, h: b.h });
    // imageRectToScreen is in CSS px of the view; convert back to output px via the zoom.
    const out = ed.layout.content;
    const k = ed.zoom;
    const view = ed.imageRectToScreen({ x: ed.doc.crop?.x ?? 0, y: ed.doc.crop?.y ?? 0, w: 0, h: 0 });
    const x0 = Math.round(out.x + (tl.x - view.x) / k);
    const y0 = Math.round(out.y + (tl.y - view.y) / k);
    const w = Math.round(tl.w / k);
    const h = Math.round(tl.h / k);
    const data = ctx.getImageData(x0, y0, w, h).data;
    let sum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const i = (y * w + x) * 4;
        const j = i - 4;
        sum += Math.abs(data[i]! - data[j]!) + Math.abs(data[i + 1]! - data[j + 1]!) + Math.abs(data[i + 2]! - data[j + 2]!);
      }
    }
    return sum / (w * h);
  }, box);
}

test.describe('editor smoke', () => {
  test('capture -> balance -> redact -> copy text -> annotate -> export', async ({ page }) => {
    const errors = await open(page);

    await test.step('auto-balance and auto background ran on load', async () => {
      const doc = await getDoc(page);
      expect(doc.padding).toBeGreaterThan(0);
      expect(doc.background.type).toBe('auto');
      expect(doc.background).toHaveProperty('stops');
      // The sample has uneven solid margins (56/24 left/right, 40/72 top/bottom) that must be trimmed away.
      expect(doc.crop).not.toBeNull();
      expect(doc.crop!.x).toBeGreaterThanOrEqual(50);
      expect(doc.crop!.y).toBeGreaterThanOrEqual(36);
      expect(doc.crop!.x + doc.crop!.w).toBeLessThanOrEqual(1262);
      expect(doc.crop!.y + doc.crop!.h).toBeLessThanOrEqual(740);
      await expect(page.locator('.pe-root canvas').first()).toBeVisible();
    });

    await test.step('run detection on the fake OCR words', async () => {
      await page.getByRole('button', { name: 'Find sensitive data' }).click();
      const rows = page.getByRole('switch');
      await expect(rows).toHaveCount(4);
      await expect(page.getByText('4 found')).toBeVisible();
      await expect(page.getByText('••••1111')).toBeVisible();
    });

    const email = await page.evaluate(
      (t) => window.__polishot!.words.find((w) => w.text === t)!.box,
      SAMPLE_TEXT.email,
    );
    const before = await sharpness(page, email);

    await test.step('apply blur to all detections', async () => {
      await page.getByRole('button', { name: 'Blur all' }).click();
      const doc = await getDoc(page);
      const blurs = doc.annotations.filter((a) => a.type === 'blur');
      expect(blurs).toHaveLength(4);
      for (const b of blurs) {
        expect(b).toMatchObject({ source: 'auto', mode: 'blur' });
      }
      await expect(page.getByText('4 of 4 hidden')).toBeVisible();
      // The effect is a real pixel effect on the source region: the email area is much smoother afterwards.
      const after = await sharpness(page, email);
      expect(after).toBeLessThan(before * 0.35);
    });

    await test.step('undo and redo', async () => {
      await page.keyboard.press('Control+z');
      expect((await getDoc(page)).annotations).toHaveLength(0);
      await page.keyboard.press('Control+Shift+z');
      expect((await getDoc(page)).annotations).toHaveLength(4);
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+y');
      expect((await getDoc(page)).annotations).toHaveLength(4);
    });

    await test.step('copy all text puts the recognised text on the clipboard', async () => {
      await page.getByRole('button', { name: 'Copy all text' }).click();
      await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
      const text = await page.evaluate(() => navigator.clipboard.readText());
      for (const s of Object.values(SAMPLE_TEXT)) expect(text).toContain(s);
      expect(text).toContain('Billing');
      expect(text).toContain('\n');
    });

    await test.step('draw an arrow: keyboard tool switch plus a mouse drag', async () => {
      await page.locator('.pe-root').focus();
      await page.keyboard.press('a');
      expect(await page.evaluate(() => window.__polishot!.editor.tool)).toBe('arrow');
      await expect(page.getByRole('button', { name: 'Arrow' })).toHaveAttribute('aria-pressed', 'true');
      const from = await screenOf(page, 360, 300);
      const to = await screenOf(page, 700, 420);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
      await page.mouse.move(to.x, to.y, { steps: 5 });
      await page.mouse.up();
      const arrow = (await getDoc(page)).annotations.find(
        (a): a is Extract<Annotation, { points: [number, number, number, number] }> => a.type === 'arrow',
      );
      expect(arrow).toBeDefined();
      const [x1, y1, x2, y2] = arrow!.points;
      expect(Math.abs(x1 - 360)).toBeLessThan(3);
      expect(Math.abs(y1 - 300)).toBeLessThan(3);
      expect(Math.abs(x2 - 700)).toBeLessThan(3);
      expect(Math.abs(y2 - 420)).toBeLessThan(3);
    });

    await test.step('export PNG at 2x matches computeLayout x 2', async () => {
      await page.getByRole('button', { name: 'Scale 2x' }).click();
      await page.getByRole('button', { name: 'Save image' }).click();
      await page.waitForFunction(() => window.__polishot!.lastExport !== null);
      const dims = await page.evaluate(async () => {
        const r = window.__polishot!.lastExport!;
        const bmp = await createImageBitmap(r.blob);
        return { w: bmp.width, h: bmp.height, type: r.blob.type, filename: r.filename };
      });
      const doc = await getDoc(page);
      const layout = computeLayout(doc);
      expect(dims.type).toBe('image/png');
      expect(dims.w).toBe(layout.width * 2);
      expect(dims.h).toBe(layout.height * 2);
      expect(dims.filename).toMatch(/\.png$/);
    });

    await page.screenshot({ path: `${SHOTS}/editor-light.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('dark theme screenshot', async ({ page }) => {
    const errors = await open(page, 'dark');
    await page.getByRole('button', { name: 'Find sensitive data' }).click();
    await page.getByRole('button', { name: 'Blur all' }).click();
    await page.locator('.pe-root').focus();
    await page.keyboard.press('r');
    const a = await screenOf(page, 330, 560);
    const b = await screenOf(page, 760, 640);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.screenshot({ path: `${SHOTS}/editor-dark.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('watermark is gated by the licence', async ({ page }) => {
    await open(page);
    const region = async () =>
      page.evaluate(async () => {
        const ed = window.__polishot!.editor;
        const blob = await ed.export({ format: 'png', quality: 1, scale: 1, licensed: true });
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        // Bottom-right corner band where the watermark sits.
        const w = 220;
        const h = 40;
        const data = ctx.getImageData(bmp.width - w - 4, bmp.height - h - 4, w, h).data;
        let sum = 0;
        for (let i = 4; i < data.length; i += 4) sum += Math.abs(data[i]! - data[i - 4]!);
        return sum / (w * h);
      });
    const free = await region();
    await page.getByRole('button', { name: 'Free' }).click();
    await expect(page.getByRole('button', { name: 'Licensed' })).toBeVisible();
    const licensed = await region();
    expect(free).toBeGreaterThan(licensed * 3 + 0.5);
    await expect(page.getByText('Free exports include a small watermark.')).toHaveCount(0);
  });

  test('tools: step numbers, text is plain text, shapes select and delete', async ({ page }) => {
    const errors = await open(page);
    await page.locator('.pe-root').focus();

    // Steps auto-increment.
    await page.keyboard.press('n');
    for (const [x, y] of [
      [330, 120],
      [330, 160],
      [330, 200],
    ] as const) {
      const p = await screenOf(page, x, y);
      await page.mouse.click(p.x, p.y);
    }
    let doc = await getDoc(page);
    expect(doc.annotations.filter((a) => a.type === 'step').map((a) => (a.type === 'step' ? a.n : 0))).toEqual([1, 2, 3]);

    // Text: typed markup stays literal text.
    await page.keyboard.press('t');
    const tp = await screenOf(page, 700, 150);
    await page.mouse.click(tp.x, tp.y);
    const field = page.locator('textarea.pe-text-input');
    await expect(field).toBeVisible();
    await field.fill('<img src=x onerror=alert(1)> note');
    await field.press('Control+Enter');
    doc = await getDoc(page);
    const text = doc.annotations.find((a) => a.type === 'text');
    expect(text && text.type === 'text' && text.text).toBe('<img src=x onerror=alert(1)> note');
    expect(await page.locator('.pe-root img').count()).toBe(0);
    // The Text tool stays active after a note (UX bar: the tool persists); Esc / V return to Select.
    expect(await page.evaluate(() => window.__polishot!.editor.tool)).toBe('text');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__polishot!.editor.tool)).toBe('select');

    // Rectangle, then select it by clicking its edge and delete it.
    await page.keyboard.press('r');
    const a = await screenOf(page, 340, 520);
    const b = await screenOf(page, 560, 600);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    doc = await getDoc(page);
    const rect = doc.annotations.find((x) => x.type === 'rect')!;
    expect(rect).toBeDefined();
    await page.keyboard.press('v');
    const edge = await screenOf(page, 340, 560);
    await page.mouse.click(edge.x, edge.y);
    expect(await page.evaluate(() => window.__polishot!.editor.selectedId)).toBe(rect.id);
    await page.keyboard.press('Delete');
    doc = await getDoc(page);
    expect(doc.annotations.some((x) => x.type === 'rect')).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('select, move and resize with the transformer; one undo step each', async ({ page }) => {
    const errors = await open(page);
    await page.locator('.pe-root').focus();
    await page.keyboard.press('r');
    const a = await screenOf(page, 340, 520);
    const b = await screenOf(page, 560, 600);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    const rectOf = async () =>
      (await getDoc(page)).annotations.find((x) => x.type === 'rect')! as Extract<Annotation, { w: number; strokeWidth: number }>;
    const r0 = await rectOf();
    await page.keyboard.press('v');
    // Click on the top edge, a quarter along (away from the resize anchors).
    const edge = await screenOf(page, r0.x + r0.w * 0.25, r0.y);
    await page.mouse.click(edge.x, edge.y);
    expect(await page.evaluate(() => window.__polishot!.editor.selectedId)).toBe(r0.id);

    // Resize by dragging the bottom-right anchor.
    const corner = await screenOf(page, r0.x + r0.w, r0.y + r0.h);
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move(corner.x + 60, corner.y + 40, { steps: 6 });
    await page.mouse.up();
    const r1 = await rectOf();
    expect(r1.x).toBeCloseTo(r0.x, 1);
    expect(r1.y).toBeCloseTo(r0.y, 1);
    expect(r1.w).toBeGreaterThan(r0.w + 40);
    expect(r1.h).toBeGreaterThan(r0.h + 25);

    // Move by dragging the top edge.
    const grab = await screenOf(page, r1.x + r1.w * 0.25, r1.y);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 50, grab.y + 30, { steps: 6 });
    await page.mouse.up();
    const r2 = await rectOf();
    expect(r2.x).toBeGreaterThan(r1.x + 40);
    expect(r2.y).toBeGreaterThan(r1.y + 20);
    expect(r2.w).toBeCloseTo(r1.w, 1);

    // Each gesture is exactly one undo step.
    await page.keyboard.press('Control+z');
    expect((await rectOf()).x).toBeCloseTo(r1.x, 1);
    await page.keyboard.press('Control+z');
    expect((await rectOf()).w).toBeCloseTo(r0.w, 1);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a slider drag is a single undo step', async ({ page }) => {
    await open(page);
    const before = (await getDoc(page)).padding;
    const slider = page.getByLabel('Padding');
    const box = (await slider.boundingBox())!;
    await page.mouse.move(box.x + box.width * (before / 0.3), box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    const after = (await getDoc(page)).padding;
    expect(after).toBeGreaterThan(before + 0.05);
    await page.keyboard.press('Control+z');
    expect((await getDoc(page)).padding).toBeCloseTo(before, 3);
    expect(await page.evaluate(() => window.__polishot!.editor.canUndo())).toBe(false);
    await page.keyboard.press('Control+Shift+z');
    expect((await getDoc(page)).padding).toBeCloseTo(after, 3);
  });

  test('brush, pixelate and bar are real pixel effects on the source', async ({ page }) => {
    const errors = await open(page);
    const word = (t: string) => page.evaluate((t) => window.__polishot!.words.find((w) => w.text === t)!.box, t);
    const email = await word(SAMPLE_TEXT.email);
    const card = await word('4111');
    const ip = await word(SAMPLE_TEXT.ip);
    const drag = async (pts: [number, number][]) => {
      const ps = [];
      for (const p of pts) ps.push(await screenOf(page, p[0], p[1]));
      await page.mouse.move(ps[0]!.x, ps[0]!.y);
      await page.mouse.down();
      for (const p of ps.slice(1)) await page.mouse.move(p.x, p.y, { steps: 4 });
      await page.mouse.up();
    };
    const emailBefore = await sharpness(page, email);
    const cardBox = { x: card.x, y: card.y, w: 4 * 55, h: card.h };
    const cardBefore = await sharpness(page, cardBox);
    await page.locator('.pe-root').focus();

    await page.keyboard.press('p'); // brush, blur mode by default
    const cy = email.y + email.h / 2;
    await drag([
      [email.x - 8, cy],
      [email.x + email.w / 2, cy + 1],
      [email.x + email.w + 8, cy],
    ]);
    await page.keyboard.press('b');
    await page.getByRole('button', { name: 'Pixelate' }).click();
    await drag([
      [cardBox.x - 4, cardBox.y - 4],
      [cardBox.x + cardBox.w + 4, cardBox.y + cardBox.h + 4],
    ]);
    await page.getByRole('button', { name: 'Bar' }).click();
    await drag([
      [ip.x - 4, ip.y - 3],
      [ip.x + ip.w + 4, ip.y + ip.h + 3],
    ]);
    const doc = await getDoc(page);
    expect(
      doc.annotations.map((x) => (x.type === 'blur' || x.type === 'redact-brush' ? `${x.type}:${x.mode}` : x.type)),
    ).toEqual(['redact-brush:blur', 'blur:pixelate', 'blur:bar']);
    expect(await sharpness(page, email)).toBeLessThan(emailBefore * 0.4);
    expect(await sharpness(page, cardBox)).toBeLessThan(cardBefore * 0.7);

    // A bar is opaque: the exported pixel at its centre is the bar colour, whatever was underneath.
    const centre = await page.evaluate(async (b) => {
      const ed = window.__polishot!.editor;
      const blob = await ed.export({ format: 'png', quality: 1, scale: 1, licensed: true });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const l = ed.layout;
      const crop = ed.doc.crop!;
      const x = Math.round(l.content.x + (b.x + b.w / 2 - crop.x) * l.content.scale);
      const y = Math.round(l.content.y + (b.y + b.h / 2 - crop.y) * l.content.scale);
      return Array.from(ctx.getImageData(x, y, 1, 1).data);
    }, ip);
    expect(centre[0]).toBeLessThan(30);
    expect(centre[1]).toBeLessThan(30);
    expect(centre[3]).toBe(255);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('exports every format and scale at the computed size', async ({ page }) => {
    await open(page);
    // Transparent backdrop so JPEG's opaque matte is observable.
    await page.evaluate(() => window.__polishot!.editor.update({ background: { type: 'none' } }));
    const results = await page.evaluate(async () => {
      const ed = window.__polishot!.editor;
      const out: { format: string; scale: number; type: string; w: number; h: number; corner: number[] }[] = [];
      for (const format of ['png', 'jpeg', 'webp'] as const) {
        for (const scale of [1, 2, 3] as const) {
          const blob = await ed.export({ format, quality: 0.8, scale, licensed: true });
          const bmp = await createImageBitmap(blob);
          const c = document.createElement('canvas');
          c.width = bmp.width;
          c.height = bmp.height;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(bmp, 0, 0);
          out.push({
            format,
            scale,
            type: blob.type,
            w: bmp.width,
            h: bmp.height,
            corner: Array.from(ctx.getImageData(0, 0, 1, 1).data),
          });
        }
      }
      return out;
    });
    const layout = computeLayout(await getDoc(page));
    for (const r of results) {
      expect(r.type).toBe(`image/${r.format}`);
      expect(r.w).toBe(layout.width * r.scale);
      expect(r.h).toBe(layout.height * r.scale);
      if (r.format === 'png') expect(r.corner[3]).toBe(0); // transparent
      if (r.format === 'jpeg') {
        expect(r.corner[3]).toBe(255);
        expect(r.corner[0]).toBeGreaterThan(240); // white matte
      }
    }
  });

  test('backgrounds: custom colours apply, image backgrounds are restricted to safe sources', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Custom background' }).click();
    await page.getByRole('button', { name: 'Solid' }).click();
    await page.locator('input[type=color]').first().fill('#336699');
    expect((await getDoc(page)).background).toEqual({ type: 'solid', color: '#336699' });

    // Unsafe sources are ignored: the document keeps its previous background.
    for (const src of [
      'https://evil.example/x.png',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    ]) {
      await page.evaluate((s) => window.__polishot!.editor.update({ background: { type: 'image', src: s, blur: 10 } }), src);
      expect((await getDoc(page)).background.type).toBe('solid');
    }

    // A data: image works and is blurred cover-fit across the canvas.
    const dataUrl = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#cc3322';
      ctx.fillRect(0, 0, 64, 64);
      return c.toDataURL('image/png');
    });
    await page.evaluate(
      (src) => window.__polishot!.editor.update({ background: { type: 'image', src, blur: 30 }, padding: 0.2 }),
      dataUrl,
    );
    const px = await page.evaluate(async () => {
      const ed = window.__polishot!.editor;
      const blob = await ed.export({ format: 'png', quality: 1, scale: 1, licensed: true });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      return Array.from(ctx.getImageData(3, 3, 1, 1).data);
    });
    expect(px[0]).toBeGreaterThan(180);
    expect(px[1]).toBeLessThan(80);
  });

  test('a 4K screenshot loads to first paint within the editor budget', async ({ page }) => {
    await open(page);
    // Warm-up load (JIT), then measure a fresh 3840x2400 decoded bitmap, the way a real host supplies images.
    await page.evaluate(() => window.__polishot!.loadSampleBitmap(1));
    const ms = await page.evaluate(() => window.__polishot!.loadSampleBitmap(3));
    const timings = await page.evaluate(() => window.__polishot!.editor.timings);
    console.log(`4K load: ${ms.toFixed(1)} ms ${JSON.stringify(timings)}`);
    expect(ms).toBeLessThan(150);
    const doc = await getDoc(page);
    expect(doc.image.width).toBe(3840);
    expect(doc.crop).not.toBeNull();
  });

  test('keyboard reaches every tool and exposes pressed state', async ({ page }) => {
    await open(page);
    const toolbar = page.getByRole('toolbar', { name: 'Annotation tools' });
    await toolbar.getByRole('button', { name: 'Select', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(toolbar.getByRole('button', { name: 'Arrow' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toolbar.getByRole('button', { name: 'Arrow' })).toHaveAttribute('aria-pressed', 'true');
    await expect(toolbar.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'false');
  });
});


/* ------------------------------------------------------------------ */
/* Pro: brand mark, limits                                                */
/* ------------------------------------------------------------------ */

interface MarkAnalysis {
  /** Number of non-white pixels in the band below the picture (the corner mark and nothing else). */
  ink: number;
  /** Bounding box of those pixels in output px, or null when the band is clean. */
  box: { x: number; y: number; w: number; h: number } | null;
  /** FNV-1a hash of every pixel of the band, for exact equality checks. */
  hash: string;
  /** Mean colour of the ink pixels. */
  mean: [number, number, number];
  width: number;
  height: number;
}

/** Plain, shadow-free, white canvas with a fat bottom band, so the corner mark is the only thing in it. */
async function prepareMarkCanvas(page: Page) {
  await page.evaluate(() =>
    window.__polishot!.editor.update({ background: { type: 'solid', color: '#ffffff' }, padding: 0.22, shadow: 0, radius: 0, frame: 'none' }),
  );
}

/** Exports at 1x and analyses the band under the picture where the watermark / brand mark sits. */
function analyseExport(page: Page): Promise<MarkAnalysis> {
  return page.evaluate(async () => {
    const ed = window.__polishot!.editor;
    const blob = await ed.export({ format: 'png', quality: 1, scale: 1, licensed: true });
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const l = ed.layout;
    const top = Math.ceil(l.frame.y + l.frame.h) + 3;
    const data = ctx.getImageData(0, top, c.width, c.height - top).data;
    let minX = 1e9;
    let minY = 1e9;
    let maxX = -1;
    let maxY = -1;
    let ink = 0;
    let hash = 2166136261;
    const sum = [0, 0, 0];
    const w = c.width;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ data[i]!, 16777619) ^ data[i + 1]!;
      hash = Math.imul(hash ^ data[i + 2]!, 16777619);
      if (Math.min(data[i]!, data[i + 1]!, data[i + 2]!) < 235) {
        const p = i / 4;
        const x = p % w;
        const y = Math.floor(p / w) + top;
        ink++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        sum[0]! += data[i]!;
        sum[1]! += data[i + 1]!;
        sum[2]! += data[i + 2]!;
      }
    }
    return {
      ink,
      box: ink ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
      hash: String(hash >>> 0),
      mean: (ink ? sum.map((v) => v / ink) : [255, 255, 255]) as [number, number, number],
      width: c.width,
      height: c.height,
    };
  });
}

/** The same band read from what is on screen (the main Konva layer), mapped back to output px. */
function analyseScreen(page: Page): Promise<{ ink: number; box: { x: number; y: number; w: number; h: number } | null }> {
  return page.evaluate(async () => {
    const ed = window.__polishot!.editor;
    // Let a just-loaded logo or any queued draw finish first.
    await new Promise((r) => setTimeout(r, 150));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const main = ed.element.querySelectorAll('canvas')[1] as HTMLCanvasElement;
    const ctx = main.getContext('2d')!;
    const ratio = main.width / main.clientWidth;
    const l = ed.layout;
    const content = ed.contentRectOnScreen();
    const k = ed.zoom;
    const bandTopCss = content.y + (l.frame.y + l.frame.h - l.content.y) * k + 3;
    const y0 = Math.ceil(bandTopCss * ratio);
    const data = ctx.getImageData(0, y0, main.width, main.height - y0).data;
    let minX = 1e9;
    let minY = 1e9;
    let maxX = -1;
    let maxY = -1;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 40) {
        const p = i / 4;
        const x = p % main.width;
        const y = Math.floor(p / main.width) + y0;
        ink++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (!ink) return { ink: 0, box: null };
    // device px -> css px -> output (design) px
    const toDesign = (xDev: number, yDev: number) => ({
      x: l.content.x + (xDev / ratio - content.x) / k,
      y: l.content.y + (yDev / ratio - content.y) / k,
    });
    const a = toDesign(minX, minY);
    const b = toDesign(maxX + 1, maxY + 1);
    return { ink, box: { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y } };
  });
}

/** A recognisable red logo with a white dot, as a PNG data URL. */
function makeLogo(page: Page, w = 240, h = 80): Promise<string> {
  return page.evaluate(
    ({ w, h }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#d02020';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(h / 2, h / 2, h / 4, 0, Math.PI * 2);
      ctx.fill();
      return c.toDataURL('image/png');
    },
    { w, h },
  );
}

const setLicensed = (page: Page, v: boolean) => page.evaluate((v) => window.__polishot!.editor.setLicensed(v), v);

test.describe('pro features', () => {
  test('brand mark replaces the watermark for Pro and is ignored (fail closed) for Free', async ({ page }) => {
    const errors = await open(page);
    await prepareMarkCanvas(page);

    // Free, no brand mark: our watermark, bottom-right.
    const defaultMark = await analyseExport(page);
    expect(defaultMark.ink).toBeGreaterThan(150);
    expect(defaultMark.box).not.toBeNull();
    const dbox = defaultMark.box!;
    expect(dbox.x + dbox.w).toBeGreaterThan(defaultMark.width * 0.85);
    expect(dbox.y + dbox.h).toBeGreaterThan(defaultMark.height * 0.9);

    // Free with a brand mark set: the mark is ignored, the default watermark is drawn, byte for byte.
    expect(await page.evaluate(() => window.__polishot!.editor.setBrandMark({ type: 'text', text: 'ACME Studio' }))).toBe(true);
    expect(await page.evaluate(() => window.__polishot!.editor.licensed)).toBe(false);
    const freeWithMark = await analyseExport(page);
    expect(freeWithMark.hash).toBe(defaultMark.hash);
    expect(freeWithMark.ink).toBe(defaultMark.ink);
    // ...and the same on screen, and when the caller tries to force the flag.
    const screenFree = await analyseScreen(page);
    expect(screenFree.box).not.toBeNull();
    const forced = await page.evaluate(async () => {
      const api = window.__polishot!;
      const out: Record<string, number> = {};
      for (const flag of [false, undefined, 'true', 1, null]) {
        const blob = await api.exportDoc(api.editor.doc, api.image!, { format: 'png', quality: 1, scale: 1, licensed: flag as never }, { brandMark: { type: 'text', text: 'ACME Studio' } });
        out[String(flag)] = blob.size;
      }
      const clean = await api.exportDoc(api.editor.doc, api.image!, { format: 'png', quality: 1, scale: 1, licensed: true }, { brandMark: null });
      out.licensedClean = clean.size;
      return out;
    });
    // Every non-boolean-true flag renders the default watermark, so they all produce the same bytes.
    expect(new Set([forced['false'], forced['undefined'], forced['true'], forced['1'], forced['null']]).size).toBe(1);
    expect(forced.licensedClean).not.toBe(forced['false']);

    // Pro with the text mark: ours is gone, theirs is drawn bottom-right.
    await setLicensed(page, true);
    const proText = await analyseExport(page);
    expect(proText.hash).not.toBe(defaultMark.hash);
    expect(proText.ink).toBeGreaterThan(100);
    const tbox = proText.box!;
    expect(tbox.x + tbox.w).toBeGreaterThan(proText.width * 0.85);
    expect(tbox.y + tbox.h).toBeGreaterThan(proText.height * 0.9);
    expect(tbox.x + tbox.w).toBeLessThan(proText.width);
    expect(tbox.w).toBeLessThan(proText.width * 0.5);

    // On screen it is the same picture as the export, within a couple of pixels.
    const screenText = await analyseScreen(page);
    expect(screenText.box).not.toBeNull();
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      expect(Math.abs(screenText.box![key] - tbox[key]), key).toBeLessThan(4);
    }

    // Pro with no brand mark is a clean export.
    await page.evaluate(() => window.__polishot!.editor.setBrandMark(null));
    const clean = await analyseExport(page);
    expect(clean.ink).toBe(0);
    expect((await analyseScreen(page)).ink).toBe(0);

    // Pro with a logo: scaled to the weight of the watermark, bottom-right, in the logo's own colour.
    const logo = await makeLogo(page);
    expect(await page.evaluate((src) => window.__polishot!.editor.setBrandMark({ type: 'image', src }), logo)).toBe(true);
    const proLogo = await analyseExport(page);
    expect(proLogo.ink).toBeGreaterThan(200);
    expect(proLogo.mean[0]).toBeGreaterThan(proLogo.mean[1] + 60);
    const lbox = proLogo.box!;
    expect(lbox.x + lbox.w).toBeGreaterThan(proLogo.width * 0.85);
    expect(lbox.y + lbox.h).toBeGreaterThan(proLogo.height * 0.9);
    expect(lbox.h).toBeLessThan(80);
    expect(lbox.w / lbox.h).toBeGreaterThan(2.4);
    expect(lbox.w / lbox.h).toBeLessThan(3.6);
    const screenLogo = await analyseScreen(page);
    expect(screenLogo.box).not.toBeNull();
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      expect(Math.abs(screenLogo.box![key] - lbox[key]), key).toBeLessThan(4);
    }

    // The logo is Pro-only too: dropping the licence brings our watermark back at once.
    await setLicensed(page, false);
    expect((await analyseExport(page)).hash).toBe(defaultMark.hash);

    // Unsafe logo sources are refused and never drawn.
    await setLicensed(page, true);
    for (const src of ['https://evil.example/logo.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'file:///etc/passwd']) {
      expect(await page.evaluate((s) => window.__polishot!.editor.setBrandMark({ type: 'image', src: s }), src), src).toBe(false);
      expect(await page.evaluate(() => window.__polishot!.editor.brandMark)).toBeNull();
    }
    expect((await analyseExport(page)).ink).toBe(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('inspector: locked brand mark row and the 3-preset limit for Free', async ({ page }) => {
    const errors = await open(page);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });

    // Free: a locked row with a small Pro tag; clicking it asks the host to show pricing.
    const brand = inspector.locator('section', { has: page.getByRole('heading', { name: 'Brand mark' }) });
    await expect(brand).toBeVisible();
    await expect(brand.locator('.pe-protag')).toHaveText('Pro');
    await expect(brand.getByRole('textbox')).toHaveCount(0);
    await brand.getByRole('button', { name: /Brand mark is a Pro feature/ }).click();
    await expect(page.getByTestId('status')).toHaveText(/Upgrade/);

    // Saved looks: three fit, the fourth is blocked with a quiet note.
    const looks = inspector.locator('section', { has: page.getByRole('heading', { name: 'Saved looks' }) });
    const name = looks.getByLabel('Name for this look');
    const note = 'Free keeps 3 presets \u2014 Pro removes the limit';
    await expect(looks.getByText(note)).toBeVisible();
    for (const n of ['Docs', 'Social', 'Dark']) {
      await name.fill(n);
      await looks.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(looks.getByRole('button', { name: n, exact: true })).toBeVisible();
    }
    await expect(looks.getByText('3 of 3')).toBeVisible();
    await expect(name).toBeDisabled();
    await expect(looks.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(looks.getByText(note)).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pe-playground-looks') ?? '[]').length)).toBe(3);

    // Deleting one frees a slot.
    await looks.getByRole('button', { name: 'Delete look Dark' }).click();
    await expect(name).toBeEnabled();
    await expect(looks.getByText('2 of 3')).toBeVisible();

    await page.screenshot({ path: SHOTS + '/pro-free-state.png' });
    await looks.scrollIntoViewIfNeeded();
    await page.locator('.pe-sidebar-scroll').screenshot({ path: SHOTS + '/pro-inspector-free-bottom.png' });

    // Pro: the note and the limit go away, the brand mark controls unlock.
    await page.getByRole('button', { name: 'Free' }).click();
    await expect(looks.getByText(note)).toHaveCount(0);
    await expect(looks.getByText(/\d of 3/)).toHaveCount(0);
    for (const n of ['A', 'B', 'C']) {
      await name.fill(n);
      await looks.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(looks.getByRole('button', { name: n, exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pe-playground-looks') ?? '[]').length)).toBe(5);

    await expect(brand.locator('.pe-protag')).toHaveCount(0);
    await brand.getByRole('button', { name: 'Text brand mark' }).click();
    await brand.getByLabel('Brand mark text').fill('  @acme  studio ');
    expect(await page.evaluate(() => window.__polishot!.editor.brandMark)).toEqual({ type: 'text', text: '@acme studio' });
    // Typing a trailing space is not "corrected" under the caret.
    await expect(brand.getByLabel('Brand mark text')).toHaveValue('  @acme  studio ');
    await brand.getByRole('button', { name: 'No brand mark' }).click();
    expect(await page.evaluate(() => window.__polishot!.editor.brandMark)).toBeNull();
    await brand.getByRole('button', { name: 'Logo brand mark' }).click();
    const logo = await makeLogo(page, 400, 120);
    await brand.getByLabel('Choose a logo image').setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(logo.split(',')[1]!, 'base64'),
    });
    await expect(brand.getByRole('img', { name: 'Your logo' })).toBeVisible();
    expect(await page.evaluate(() => window.__polishot!.editor.brandMark?.type)).toBe('image');
    // Wrong file types are refused with a plain sentence.
    await brand.getByLabel('Choose a logo image').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await expect(brand.getByRole('alert')).toHaveText(/PNG, JPEG, WebP or GIF under 2 MB/);

    await page.locator('.pe-sidebar-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.locator('.pe-sidebar-scroll').screenshot({ path: SHOTS + '/pro-inspector-pro-bottom.png' });
    await page.screenshot({ path: SHOTS + '/pro-brand-logo.png' });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
