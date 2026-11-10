import { describe, expect, it } from 'vitest';
import { FRAME_IDS, frameSpec } from '../src/frames';
import {
  MAX_EXPORT_PIXELS,
  MAX_EXPORT_SIDE,
  computeExportSize,
  computeLayout,
  outputToSource,
  presetSize,
  sourceToOutput,
} from '../src/layout';
import { PRESETS, PRESET_ORDER } from '../src/presets';
import type { EditorDoc, FrameId, PresetId } from '../src/types';
import { docFor } from './helpers';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

function withPreset(preset: PresetId, patch: Partial<EditorDoc> = {}): EditorDoc {
  const doc = docFor(1280, 720, { preset, padding: 0.1, ...patch });
  if (preset === 'custom') doc.custom = { width: 1000, height: 600 };
  return doc;
}

describe('computeLayout', () => {
  for (const preset of PRESET_ORDER) {
    describe(`preset ${preset}`, () => {
      for (const frame of FRAME_IDS) {
        it(`frame ${frame}: matches target size, contains and centres the content`, () => {
          const doc = withPreset(preset, { frame, crop: { x: 20, y: 10, w: 1000, h: 600 } });
          const layout = computeLayout(doc);
          const target = presetSize(doc);
          if (target) {
            expect(layout.width).toBe(target.width);
            expect(layout.height).toBe(target.height);
          } else {
            expect(layout.content.scale).toBe(1);
            expect(Number.isInteger(layout.width)).toBe(true);
            expect(Number.isInteger(layout.height)).toBe(true);
          }
          const { content, frame: fr } = layout;
          // Contained: the framed object and the content lie inside the canvas.
          expect(fr.x).toBeGreaterThanOrEqual(-1e-9);
          expect(fr.y).toBeGreaterThanOrEqual(-1e-9);
          expect(fr.x + fr.w).toBeLessThanOrEqual(layout.width + 1e-9);
          expect(fr.y + fr.h).toBeLessThanOrEqual(layout.height + 1e-9);
          expect(content.x).toBeGreaterThanOrEqual(fr.x - 1e-9);
          expect(content.y).toBeGreaterThanOrEqual(fr.y - 1e-9);
          expect(content.x + content.w).toBeLessThanOrEqual(fr.x + fr.w + 1e-9);
          expect(content.y + content.h).toBeLessThanOrEqual(fr.y + fr.h + 1e-9);
          // Centred: equal margins on opposite sides.
          close(fr.x, layout.width - (fr.x + fr.w));
          close(fr.y, layout.height - (fr.y + fr.h));
          // The content is scaled uniformly.
          close(content.w, 1000 * content.scale);
          close(content.h, 600 * content.scale);
          if (frame === 'none') {
            close(content.x, fr.x);
            close(content.y, fr.y);
            close(content.w, fr.w);
          }
        });
      }
    });
  }

  it('auto layout: padding is a fraction of the longer content side, equal on all sides', () => {
    const doc = docFor(1000, 500, { padding: 0.1 });
    const l = computeLayout(doc);
    expect(l.width).toBe(1200);
    expect(l.height).toBe(700);
    expect(l.content).toEqual({ x: 100, y: 100, w: 1000, h: 500, scale: 1 });
    expect(l.pad).toBe(100);
  });

  it('zero padding makes the content fill the canvas', () => {
    const l = computeLayout(docFor(640, 360, { padding: 0 }));
    expect(l.width).toBe(640);
    expect(l.height).toBe(360);
    expect(l.content).toMatchObject({ x: 0, y: 0, w: 640, h: 360, scale: 1 });
  });

  it('fixed preset: scales to fit with the requested padding fraction', () => {
    const doc = docFor(1600, 900, { preset: 'ig-square', padding: 0.1 });
    const l = computeLayout(doc);
    expect(l.width).toBe(1080);
    expect(l.height).toBe(1080);
    // Width is the limiting side: 1600 * s + 2 * 0.1 * 1600 * s = 1080
    close(l.content.scale, 1080 / (1600 * 1.2));
    close(l.content.x, 0.1 * 1600 * l.content.scale);
    close(l.content.y, (1080 - 900 * l.content.scale) / 2);
  });

  it('a tall story canvas letterboxes a wide screenshot vertically', () => {
    const l = computeLayout(docFor(1920, 1080, { preset: 'ig-story', padding: 0.08 }));
    expect(l.width).toBe(1080);
    expect(l.height).toBe(1920);
    close(l.content.y + l.content.h / 2, 960);
    close(l.content.x + l.content.w / 2, 540);
  });

  it('uses the crop, not the full image, as the content box', () => {
    const l = computeLayout(docFor(1000, 800, { crop: { x: 100, y: 100, w: 400, h: 200 }, padding: 0 }));
    expect(l.width).toBe(400);
    expect(l.height).toBe(200);
  });

  it('frames add chrome around the content and the canvas grows with it', () => {
    const none = computeLayout(docFor(800, 600, { padding: 0 }));
    const browser = computeLayout(docFor(800, 600, { padding: 0, frame: 'browser-light' }));
    const spec = frameSpec('browser-light', 800, 600);
    expect(browser.width).toBe(none.width);
    expect(browser.height).toBe(none.height + spec.insets.t);
    expect(browser.content.y).toBe(spec.insets.t);
    for (const f of ['phone', 'laptop'] as FrameId[]) {
      const l = computeLayout(docFor(800, 600, { padding: 0, frame: f }));
      expect(l.width).toBeGreaterThan(none.width);
      expect(l.height).toBeGreaterThan(none.height);
    }
  });

  it('is defensive about out-of-range numbers', () => {
    const l = computeLayout(docFor(800, 600, { padding: 99 }));
    expect(l.width).toBe(Math.round(800 + 2 * 0.3 * 800));
    const nan = computeLayout(docFor(800, 600, { padding: Number.NaN }));
    expect(nan.width).toBe(800);
  });

  it('custom canvas sizes are clamped', () => {
    const doc = docFor(800, 600, { preset: 'custom', custom: { width: 5, height: 99999 } });
    const l = computeLayout(doc);
    expect(l.width).toBe(64);
    expect(l.height).toBe(8192);
  });

  it('presets have the documented sizes', () => {
    expect(PRESETS.x).toMatchObject({ width: 1600, height: 900 });
    expect(PRESETS.linkedin).toMatchObject({ width: 1200, height: 627 });
    expect(PRESETS['ig-square']).toMatchObject({ width: 1080, height: 1080 });
    expect(PRESETS['ig-story']).toMatchObject({ width: 1080, height: 1920 });
    expect(PRESETS.youtube).toMatchObject({ width: 1280, height: 720 });
  });
});

describe('coordinate mapping', () => {
  it('source <-> output are inverses and honour the crop origin', () => {
    const doc = docFor(1600, 900, { crop: { x: 100, y: 50, w: 1200, h: 700 }, preset: 'x', padding: 0.08 });
    const layout = computeLayout(doc);
    const o = sourceToOutput(doc, layout, 100, 50);
    close(o.x, layout.content.x);
    close(o.y, layout.content.y);
    const back = outputToSource(doc, layout, o.x + 37.5, o.y + 12.25);
    close(back.x, 100 + 37.5 / layout.content.scale);
    close(back.y, 50 + 12.25 / layout.content.scale);
  });
});

describe('computeExportSize', () => {
  it('multiplies the layout by the scale', () => {
    const doc = docFor(1000, 500, { padding: 0.1 });
    const l = computeLayout(doc);
    for (const s of [1, 2, 3] as const) {
      const size = computeExportSize(doc, s);
      expect(size.width).toBe(l.width * s);
      expect(size.height).toBe(l.height * s);
      expect(size.pixelRatio).toBe(s);
      expect(size.clamped).toBe(false);
    }
  });

  it('works for fixed presets', () => {
    const size = computeExportSize(docFor(1000, 500, { preset: 'x' }), 2);
    expect(size).toMatchObject({ width: 3200, height: 1800, pixelRatio: 2 });
  });

  it('clamps absurd sizes to what a canvas can hold', () => {
    const doc = docFor(12000, 9000, { padding: 0.1 });
    const size = computeExportSize(doc, 3);
    expect(size.clamped).toBe(true);
    expect(size.pixelRatio).toBeLessThan(3);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_EXPORT_SIDE);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_EXPORT_PIXELS * 1.001);
  });
});
