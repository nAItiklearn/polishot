import { detect, type OcrWord } from '@polishot/redact';
import { WATERMARK_TEXT } from '@polishot/brand';
import { describe, expect, it } from 'vitest';
import { SWATCHES, backgroundCornerColor, gradientPoints, resolveBackground } from '../src/background';
import { NEUTRAL_STOPS } from '../src/balance';
import {
  contrastRatio,
  hexToOklab,
  hueDistance,
  oklabToRgb,
  oklchToHex,
  parseColor,
  readableOn,
  rgbToHex,
  rgbToOklab,
} from '../src/color';
import { validateDoc } from '../src/doc';
import { brushBlurRadius, effectParams, redactionsFromDetections, strokeBounds } from '../src/redactions';
import { TOOL_ORDER, TOOL_SHORTCUT, mapShortcut } from '../src/shortcuts';
import { shouldWatermark, watermarkLayout } from '../src/watermark';
import { docFor } from './helpers';

describe('colour math', () => {
  it('round-trips sRGB through OKLab', () => {
    for (const [r, g, b] of [
      [0, 0, 0],
      [255, 255, 255],
      [200, 60, 50],
      [12, 200, 140],
      [128, 128, 128],
    ] as const) {
      const lab = rgbToOklab(r, g, b);
      expect(oklabToRgb(lab.L, lab.a, lab.b)).toEqual([r, g, b]);
    }
  });

  it('matches known OKLab reference values', () => {
    const white = rgbToOklab(255, 255, 255);
    expect(white.L).toBeCloseTo(1, 3);
    expect(Math.abs(white.a)).toBeLessThan(1e-3);
    const red = rgbToOklab(255, 0, 0);
    expect(red.L).toBeCloseTo(0.628, 2);
    expect(red.a).toBeCloseTo(0.2249, 2);
    expect(red.b).toBeCloseTo(0.1258, 2);
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 3);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 6);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
    expect(contrastRatio('bad', '#ffffff')).toBe(1);
  });

  it('parses only strict colour syntaxes', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('#112233')).toEqual([17, 34, 51, 1]);
    expect(parseColor('#11223344')?.[3]).toBeCloseTo(0.2667, 3);
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1]);
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 0.5]);
    expect(parseColor('red')).toBeNull();
    expect(parseColor('url(x)')).toBeNull();
    expect(parseColor('#12')).toBeNull();
    expect(parseColor('#fff;x')).toBeNull();
    expect(parseColor('x'.repeat(100))).toBeNull();
  });

  it('reduces chroma instead of clipping when out of gamut', () => {
    const hex = oklchToHex(0.7, 0.4, 150);
    const lch = hexToOklab(hex)!;
    expect(Math.hypot(lch.a, lch.b)).toBeLessThan(0.4);
    expect(hueDistance((Math.atan2(lch.b, lch.a) * 180) / Math.PI + 360, 150)).toBeLessThan(6);
  });

  it('picks readable text colours', () => {
    expect(readableOn('#101010')).toBe('#ffffff');
    expect(readableOn('#f4f4f2')).toBe('#000000');
    expect(rgbToHex(1, 2, 3)).toBe('#010203');
  });
});

describe('redactionsFromDetections', () => {
  const words: OcrWord[] = [
    { text: 'Contact:', box: { x: 100, y: 40, w: 90, h: 20 }, line: 0 },
    { text: 'jane.doe@example.com', box: { x: 200, y: 40, w: 200, h: 20 }, line: 0 },
    { text: 'Card', box: { x: 100, y: 80, w: 40, h: 20 }, line: 1 },
    { text: '4111', box: { x: 150, y: 80, w: 40, h: 20 }, line: 1 },
    { text: '1111', box: { x: 200, y: 80, w: 40, h: 20 }, line: 1 },
    { text: '1111', box: { x: 250, y: 80, w: 40, h: 20 }, line: 1 },
    { text: '1111', box: { x: 300, y: 80, w: 40, h: 20 }, line: 1 },
  ];

  it('maps each detection box to a blur annotation in image coordinates', () => {
    const dets = detect(words);
    expect(dets.length).toBeGreaterThanOrEqual(2);
    const anns = redactionsFromDetections(dets, 'blur');
    const boxes = dets.flatMap((d) => d.boxes.map((b) => ({ d, b })));
    expect(anns).toHaveLength(boxes.length);
    anns.forEach((a, i) => {
      const { d, b } = boxes[i]!;
      expect(a).toMatchObject({
        type: 'blur',
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        mode: 'blur',
        source: 'auto',
        kind: d.kind,
      });
    });
    const email = anns.find((a) => a.type === 'blur' && a.kind === 'email');
    expect(email).toBeDefined();
    // Still within the OCR word's neighbourhood: coordinates are source pixels, not normalised.
    expect(email!.type === 'blur' && email!.x).toBeGreaterThan(190);
    expect(email!.type === 'blur' && email!.w).toBeGreaterThan(190);
  });

  it('uses the requested mode, unique ids, and produces valid annotations', () => {
    const anns = redactionsFromDetections(detect(words), 'bar');
    expect(anns.every((a) => a.type === 'blur' && a.mode === 'bar')).toBe(true);
    expect(new Set(anns.map((a) => a.id)).size).toBe(anns.length);
    const doc = { ...docFor(800, 600), annotations: anns };
    expect(validateDoc(doc)).not.toBeNull();
  });

  it('skips degenerate boxes and handles no detections', () => {
    expect(redactionsFromDetections([], 'blur')).toEqual([]);
    const anns = redactionsFromDetections(
      [
        {
          id: 'd1',
          kind: 'secret',
          label: 'x',
          start: 0,
          end: 1,
          value: 'x',
          confidence: 1,
          boxes: [
            { x: 1, y: 1, w: 0, h: 5 },
            { x: 1, y: 1, w: 5, h: 5 },
          ],
        },
      ],
      'blur',
    );
    expect(anns).toHaveLength(1);
  });
});

describe('effect strength', () => {
  it('scales with the region and never goes below a safe minimum', () => {
    const small = effectParams(300, 12);
    expect(small.blurRadius).toBeGreaterThanOrEqual(8);
    expect(small.pixelSize).toBeGreaterThanOrEqual(8);
    const text = effectParams(300, 26);
    expect(text.blurRadius).toBeGreaterThanOrEqual(13);
    const big = effectParams(2000, 1500);
    expect(big.blurRadius).toBe(48);
    expect(big.pixelSize).toBeLessThanOrEqual(64);
    expect(effectParams(0, 0).blurRadius).toBeGreaterThanOrEqual(8);
  });

  it('brush blur and stroke bounds', () => {
    expect(brushBlurRadius(2)).toBe(8);
    expect(brushBlurRadius(60)).toBe(30);
    expect(strokeBounds([10, 10, 50, 30], 8)).toEqual({ x: 6, y: 6, w: 48, h: 28 });
    expect(strokeBounds([], 8)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('watermark gating', () => {
  it('is drawn only when not licensed', () => {
    expect(shouldWatermark(false)).toBe(true);
    expect(shouldWatermark(true)).toBe(false);
  });

  it('fails closed on junk', () => {
    expect(shouldWatermark(undefined as unknown as boolean)).toBe(true);
    expect(shouldWatermark('true' as unknown as boolean)).toBe(true);
    expect(shouldWatermark(1 as unknown as boolean)).toBe(true);
  });

  it('uses the brand text and scales with the canvas', () => {
    expect(WATERMARK_TEXT).toContain('Made with');
    const a = watermarkLayout(400, 300);
    const b = watermarkLayout(3000, 2000);
    expect(a.fontSize).toBeGreaterThanOrEqual(11);
    expect(b.fontSize).toBeLessThanOrEqual(30);
    expect(b.fontSize).toBeGreaterThan(a.fontSize);
    expect(a.margin).toBeGreaterThan(0);
  });
});

describe('keyboard shortcuts', () => {
  const key = (k: string, mods: Record<string, boolean> = {}) => mapShortcut({ key: k, ...mods });

  it('maps every tool letter, case-insensitively', () => {
    const expected = { v: 'select', a: 'arrow', r: 'rect', e: 'ellipse', l: 'line', t: 'text', b: 'blur', n: 'step', p: 'redact-brush' };
    for (const [k, tool] of Object.entries(expected)) {
      expect(key(k)).toEqual({ type: 'tool', tool });
      expect(key(k.toUpperCase())).toEqual({ type: 'tool', tool });
      expect(key(k, { shiftKey: true })).toEqual({ type: 'tool', tool });
    }
  });

  it('maps delete, escape, undo and redo', () => {
    expect(key('Delete')).toEqual({ type: 'delete' });
    expect(key('Backspace')).toEqual({ type: 'delete' });
    expect(key('Escape')).toEqual({ type: 'escape' });
    expect(key('z', { ctrlKey: true })).toEqual({ type: 'undo' });
    expect(key('z', { metaKey: true })).toEqual({ type: 'undo' });
    expect(key('Z', { ctrlKey: true, shiftKey: true })).toEqual({ type: 'redo' });
    expect(key('y', { ctrlKey: true })).toEqual({ type: 'redo' });
  });

  it('leaves browser shortcuts and unknown keys alone', () => {
    expect(key('a', { ctrlKey: true })).toBeNull();
    expect(key('r', { ctrlKey: true })).toBeNull();
    expect(key('a', { altKey: true })).toBeNull();
    expect(key('y', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('Enter')).toBeNull();
    expect(key('q')).toBeNull();
    expect(key('1')).toBeNull();
    expect(key('ArrowLeft')).toBeNull();
  });

  it('every tool has a unique shortcut', () => {
    const letters = TOOL_ORDER.map((t) => TOOL_SHORTCUT[t]);
    expect(new Set(letters).size).toBe(TOOL_ORDER.length);
    for (const t of TOOL_ORDER) expect(key(TOOL_SHORTCUT[t]!)).toEqual({ type: 'tool', tool: t });
  });
});

describe('backgrounds', () => {
  it('resolves auto backgrounds from stops, then colour, then a neutral fallback', () => {
    expect(resolveBackground({ type: 'auto', stops: ['#112233', '#445566'] })).toEqual({
      kind: 'gradient',
      stops: ['#112233', '#445566'],
      angle: expect.any(Number),
    });
    const fromColor = resolveBackground({ type: 'auto', color: '#fafafa' });
    expect(fromColor.kind).toBe('gradient');
    if (fromColor.kind === 'gradient') expect(contrastRatio(fromColor.stops[0], '#fafafa')).toBeGreaterThanOrEqual(3);
    const none = resolveBackground({ type: 'auto' });
    expect(none).toMatchObject({ kind: 'gradient', stops: NEUTRAL_STOPS });
  });

  it('degrades unsafe values to a neutral gradient', () => {
    expect(resolveBackground({ type: 'solid', color: 'url(x)' }).kind).toBe('gradient');
    expect(resolveBackground({ type: 'image', src: 'javascript:alert(1)', blur: 3 }).kind).toBe('gradient');
    expect(resolveBackground({ type: 'gradient', stops: ['nope', '#fff'], angle: 3 }).kind).toBe('gradient');
    expect(resolveBackground({ type: 'none' })).toEqual({ kind: 'none' });
    expect(resolveBackground({ type: 'image', src: 'data:image/png;base64,AAAA', blur: 500 })).toEqual({
      kind: 'image',
      src: 'data:image/png;base64,AAAA',
      blur: 100,
    });
  });

  it('gradient geometry spans the box exactly', () => {
    const right = gradientPoints(200, 100, 90);
    expect(right.start.x).toBeCloseTo(0);
    expect(right.end.x).toBeCloseTo(200);
    expect(right.start.y).toBeCloseTo(50);
    const diag = gradientPoints(100, 100, 135);
    expect(diag.start.x).toBeCloseTo(0);
    expect(diag.start.y).toBeCloseTo(0);
    expect(diag.end.x).toBeCloseTo(100);
    expect(diag.end.y).toBeCloseTo(100);
    const down = gradientPoints(100, 300, 180);
    expect(down.start.y).toBeCloseTo(0);
    expect(down.end.y).toBeCloseTo(300);
  });

  it('corner colour feeds the watermark colour choice', () => {
    expect(backgroundCornerColor({ kind: 'solid', color: '#123456' })).toBe('#123456');
    expect(backgroundCornerColor({ kind: 'gradient', stops: ['#111111', '#eeeeee'], angle: 0 })).toBe('#eeeeee');
    expect(backgroundCornerColor({ kind: 'none' })).toBeNull();
  });

  it('swatches are valid documents and none is a purple/blue gradient', () => {
    expect(SWATCHES.length).toBeGreaterThanOrEqual(6);
    expect(SWATCHES.length).toBeLessThanOrEqual(8);
    for (const s of SWATCHES) {
      const doc = { ...docFor(800, 600), background: s.background };
      expect(validateDoc(doc)).not.toBeNull();
      for (const stop of s.background.stops) {
        const lab = hexToOklab(stop)!;
        const hue = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
        const chroma = Math.hypot(lab.a, lab.b);
        // Purple/blue hues (about 255-340 degrees) are only allowed at near-neutral chroma.
        if (hue > 255 && hue < 340) expect(chroma).toBeLessThan(0.03);
      }
    }
  });
});
