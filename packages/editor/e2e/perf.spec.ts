import { expect, test, type Page } from '@playwright/test';
import type { EditorDoc } from '../src/types';

/*
 * Frame-rate budget for slider drags on a 4K capture.
 *
 * Measured on the production build (served on :5198 by playwright.config.ts) because dev-mode React renders
 * everything twice, and with hardware-accelerated canvas where the machine has a GPU. Headless software
 * rendering (SwiftShader) cannot reach 60 fps for a canvas this size, so there the frame budget is relaxed and
 * the renderer is printed next to the numbers. The JavaScript cost per update is asserted on every machine.
 */
test.use({
  baseURL: 'http://127.0.0.1:5198',
  launchOptions: {
    args: [
      '--use-angle=d3d11',
      '--use-gl=angle',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--enable-accelerated-2d-canvas',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
    ],
  },
});

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?theme=light');
  await page.waitForFunction(() => window.__polishot?.editor.hasImage === true);
  return errors;
}

const getDoc = (page: Page) =>
  page.evaluate(() => window.__polishot!.editor.doc) as Promise<EditorDoc>;
const canUndo = (page: Page) => page.evaluate(() => window.__polishot!.editor.canUndo());

test('60 fps slider drags on a 4K capture (measured)', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__polishot!.loadSampleBitmap(3));
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  const software =
    /swiftshader|llvmpipe|software|basic render/i.test(renderer) || renderer === 'unknown';
  await page.evaluate(() => {
    (window as unknown as { __long: number }).__long = 0;
    new PerformanceObserver((list) => {
      (window as unknown as { __long: number }).__long += list.getEntries().length;
    }).observe({ entryTypes: ['longtask'] });
  });

  // In-page: one document update per frame, like a drag at 60 Hz. Measures the work and the frame cadence.
  const synthetic = await page.evaluate(async () => {
    const ed = window.__polishot!.editor;
    const work: number[] = [];
    const gaps: number[] = [];
    ed.beginBatch();
    let last = performance.now();
    for (let i = 0; i < 150; i++) {
      const t0 = performance.now();
      ed.update({
        padding: 0.04 + (i % 60) * 0.003,
        radius: 6 + (i % 30),
        shadow: 0.2 + (i % 40) * 0.01,
      });
      work.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }
    ed.endBatch();
    work.sort((a, b) => a - b);
    gaps.sort((a, b) => a - b);
    const at = (arr: number[], q: number) => arr[Math.floor(arr.length * q)]!;
    return {
      workMedian: at(work, 0.5),
      workP95: at(work, 0.95),
      gapMedian: at(gaps, 0.5),
      gapP95: at(gaps, 0.95),
    };
  });
  console.log('renderer: ' + renderer + (software ? ' (software)' : ' (hardware)'));
  console.log('4K drag (document updates, 1 per frame): ' + JSON.stringify(synthetic));
  // The JavaScript side is tiny on any machine: well inside half a 60 Hz frame.
  expect(synthetic.workMedian).toBeLessThan(4);
  expect(synthetic.workP95).toBeLessThan(10);
  expect(synthetic.gapMedian).toBeLessThan(software ? 45 : 14);
  expect(synthetic.gapP95).toBeLessThan(software ? 70 : 24);

  // Through the real UI: a mouse drag on the Padding slider while every frame is timestamped.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __run: boolean };
    w.__frames = [];
    w.__run = true;
    const tick = (t: number) => {
      w.__frames.push(t);
      if (w.__run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const slider = page.getByLabel('Padding');
  const box = (await slider.boundingBox())!;
  const doc0 = (await getDoc(page)).padding;
  await page.mouse.move(box.x + box.width * (doc0 / 0.3), box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 90; i++) {
    const f = 0.1 + 0.6 * (0.5 - 0.5 * Math.cos((i / 90) * Math.PI * 2));
    await page.mouse.move(box.x + box.width * f, box.y + box.height / 2);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  const ui = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __run: boolean; __long: number };
    w.__run = false;
    const gaps = w.__frames.slice(1).map((t, i) => t - w.__frames[i]!);
    const sorted = [...gaps].sort((a, b) => a - b);
    return {
      frames: gaps.length,
      median: sorted[Math.floor(sorted.length / 2)]!,
      p95: sorted[Math.floor(sorted.length * 0.95)]!,
      over33: gaps.filter((g) => g > 33.4).length,
      longTasks: w.__long,
    };
  });
  console.log('4K drag (real slider): ' + JSON.stringify(ui));
  expect(ui.median).toBeLessThan(software ? 45 : 16.7);
  expect(ui.p95).toBeLessThan(software ? 70 : 28);
  if (!software) expect(ui.over33 / ui.frames).toBeLessThan(0.1);
  expect(ui.longTasks).toBeLessThanOrEqual(software ? 3 : 0);
  await page.keyboard.press('Control+z');
  expect(await canUndo(page)).toBe(false);
});
