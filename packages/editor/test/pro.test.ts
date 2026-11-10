import { describe, expect, it } from 'vitest';
import {
  BRAND_MARK_MAX_TEXT,
  brandImageBox,
  brandTextMaxWidth,
  markPlan,
  sanitizeBrandMark,
} from '../src/brandMark';
import { FREE_BATCH_LIMIT, FREE_PRESET_LIMIT, batchLimit, presetLimit } from '../src/limits';
import { planExport } from '../src/exportPlan';
import { shouldWatermark, watermarkLayout } from '../src/watermark';
import { docFor } from './helpers';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('free-tier limits', () => {
  it('Free keeps 3 presets and 5 images per batch, Pro has no limit', () => {
    expect(FREE_PRESET_LIMIT).toBe(3);
    expect(FREE_BATCH_LIMIT).toBe(5);
    expect(presetLimit(false)).toBe(3);
    expect(batchLimit(false)).toBe(5);
    expect(presetLimit(true)).toBe(Infinity);
    expect(batchLimit(true)).toBe(Infinity);
  });

  it('fails closed: only the boolean true is Pro', () => {
    for (const junk of [undefined, null, 0, 1, 'true', 'pro', {}, [], NaN, Symbol.iterator]) {
      expect(presetLimit(junk as unknown as boolean), String(junk)).toBe(3);
      expect(batchLimit(junk as unknown as boolean), String(junk)).toBe(5);
    }
  });

  it('a count under the limit is allowed and the limit itself is not exceeded', () => {
    const allowed = (count: number, pro: boolean) => count < presetLimit(pro);
    expect(allowed(2, false)).toBe(true);
    expect(allowed(3, false)).toBe(false);
    expect(allowed(50_000, true)).toBe(true);
  });
});

describe('sanitizeBrandMark', () => {
  it('accepts plain text and returns a fresh minimal object', () => {
    const input = { type: 'text', text: 'Jane Doe', extra: 'dropped', __proto__x: 1 };
    const out = sanitizeBrandMark(input);
    expect(out).toEqual({ type: 'text', text: 'Jane Doe' });
    expect(out).not.toBe(input);
    expect(Object.keys(out as object).sort()).toEqual(['text', 'type']);
  });

  it('normalises whitespace, strips control and bidi characters, and trims', () => {
    expect(sanitizeBrandMark({ type: 'text', text: '  @jane \n\t doe  ' })).toEqual({ type: 'text', text: '@jane doe' });
    const bidi = String.fromCharCode(0x202e);
    const isolate = String.fromCharCode(0x2066);
    expect(sanitizeBrandMark({ type: 'text', text: `a${bidi}b${isolate}c\u0000d\u0007e` })).toEqual({
      type: 'text',
      text: 'a b c d e',
    });
  });

  it('cuts text at the limit by characters, not UTF-16 units', () => {
    const long = 'x'.repeat(BRAND_MARK_MAX_TEXT + 25);
    expect(sanitizeBrandMark({ type: 'text', text: long })).toEqual({
      type: 'text',
      text: 'x'.repeat(BRAND_MARK_MAX_TEXT),
    });
    const emoji = '\u{1F600}'.repeat(BRAND_MARK_MAX_TEXT + 5);
    const cut = sanitizeBrandMark({ type: 'text', text: emoji });
    expect(cut && cut.type === 'text' && [...cut.text].length).toBe(BRAND_MARK_MAX_TEXT);
  });

  it('rejects empty, whitespace-only and non-string text', () => {
    for (const text of ['', '   ', '\n\t', '\u0000\u0001', 5, null, undefined, {}, ['a']]) {
      expect(sanitizeBrandMark({ type: 'text', text }), String(text)).toBeNull();
    }
  });

  it('rejects anything that is not a plain mark object', () => {
    for (const junk of [
      null,
      undefined,
      0,
      'text',
      true,
      [],
      [{ type: 'text', text: 'a' }],
      {},
      { type: 'video', src: PNG },
      { type: 'TEXT', text: 'a' },
      { text: 'a' },
      new Map(),
      Object.create({ type: 'text', text: 'inherited' }),
      Object.create(null, { text: { value: 'no type' } }),
    ]) {
      expect(sanitizeBrandMark(junk), Object.prototype.toString.call(junk)).toBeNull();
    }
    // A null-prototype object with the right own properties is fine.
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { type: 'text', text: 'ok' });
    expect(sanitizeBrandMark(bare)).toEqual({ type: 'text', text: 'ok' });
  });

  it('image sources must pass isSafeImageSrc', () => {
    expect(sanitizeBrandMark({ type: 'image', src: PNG })).toEqual({ type: 'image', src: PNG });
    expect(sanitizeBrandMark({ type: 'image', src: 'blob:https://app.example/1234' })).toEqual({
      type: 'image',
      src: 'blob:https://app.example/1234',
    });
    for (const src of [
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:text/html;base64,PGgxPg==',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://example.com/a.png',
      'https://evil.example/logo.png',
      '',
      'x'.repeat(100),
      5,
      null,
      undefined,
    ]) {
      expect(sanitizeBrandMark({ type: 'image', src }), String(src)).toBeNull();
    }
  });

  it('an allowed origin unlocks remote logos, nothing else does', () => {
    const origins = ['https://cdn.example'];
    expect(sanitizeBrandMark({ type: 'image', src: 'https://cdn.example/logo.png' }, origins)).toEqual({
      type: 'image',
      src: 'https://cdn.example/logo.png',
    });
    expect(sanitizeBrandMark({ type: 'image', src: 'https://evil.example/logo.png' }, origins)).toBeNull();
    expect(sanitizeBrandMark({ type: 'image', src: 'https://cdn.example.evil.example/l.png' }, origins)).toBeNull();
  });

  it('does not read inherited or polluted properties', () => {
    const polluted = JSON.parse('{"type":"text","text":"ok","__proto__":{"text":"evil"},"constructor":{"x":1}}') as unknown;
    expect(sanitizeBrandMark(polluted)).toEqual({ type: 'text', text: 'ok' });
    expect(({} as Record<string, unknown>).text).toBeUndefined();
  });
});

describe('markPlan: the licence gate fails closed', () => {
  const text = { type: 'text', text: 'Jane' } as const;
  const image = { type: 'image', src: PNG } as const;

  it('Free always draws the default watermark and ignores any brand mark', () => {
    for (const licensed of [false, undefined, null, 0, 1, 'true', 'yes', {}, [], NaN]) {
      for (const mark of [text, image, null, undefined, { type: 'evil' }, 'Jane']) {
        expect(markPlan(licensed, mark), `${String(licensed)} / ${JSON.stringify(mark)}`).toEqual({ kind: 'default' });
      }
    }
  });

  it('Pro draws the brand mark instead of the watermark', () => {
    expect(markPlan(true, text)).toEqual({ kind: 'text', text: 'Jane' });
    expect(markPlan(true, image)).toEqual({ kind: 'image', src: PNG });
  });

  it('Pro without a (valid) brand mark gets a clean export, never our watermark', () => {
    expect(markPlan(true, null)).toEqual({ kind: 'none' });
    expect(markPlan(true, undefined)).toEqual({ kind: 'none' });
    expect(markPlan(true, { type: 'text', text: '   ' })).toEqual({ kind: 'none' });
    expect(markPlan(true, { type: 'image', src: 'https://evil.example/x.png' })).toEqual({ kind: 'none' });
    expect(markPlan(true, { type: 'image', src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).toEqual({ kind: 'none' });
  });

  it('the plan uses the sanitised mark, so extra fields never reach the renderer', () => {
    const plan = markPlan(true, { type: 'text', text: ' Jane ', onclick: 'alert(1)' });
    expect(plan).toEqual({ kind: 'text', text: 'Jane' });
  });

  it('agrees with the export plan: the watermark flag is on exactly when the default mark is drawn', () => {
    const doc = docFor();
    const base = { format: 'png', quality: 1, scale: 1 } as const;
    for (const licensed of [true, false, undefined, 'true', 1, null]) {
      const opts = { ...base, licensed: licensed as unknown as boolean };
      expect(planExport(doc, opts).watermark).toBe(markPlan(licensed, text).kind === 'default');
      expect(shouldWatermark(licensed as unknown as boolean)).toBe(markPlan(licensed, text).kind === 'default');
    }
  });
});

describe('brand mark layout', () => {
  it('puts a logo bottom-right at the watermark margin, inside the canvas', () => {
    for (const [w, h] of [
      [1600, 900],
      [1080, 1920],
      [3840, 2400],
      [320, 200],
    ] as const) {
      const { margin } = watermarkLayout(w, h);
      const box = brandImageBox(w, h, 400, 120)!;
      expect(box.x + box.w).toBeCloseTo(w - margin, 6);
      expect(box.y + box.h).toBeCloseTo(h - margin, 6);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('scales to the weight of the text watermark and keeps the aspect ratio', () => {
    const w = 1600;
    const h = 900;
    const { fontSize } = watermarkLayout(w, h);
    for (const [nw, nh] of [
      [1000, 300],
      [300, 300],
      [64, 512],
      [4000, 100],
      [8, 8],
    ] as const) {
      const box = brandImageBox(w, h, nw, nh)!;
      expect(box.h).toBeLessThanOrEqual(fontSize * 2.2 + 1e-6);
      expect(box.w).toBeLessThanOrEqual(fontSize * 9 + 1e-6);
      expect(box.w / box.h).toBeCloseTo(nw / nh, 6);
    }
    // A wide banner is limited by width, a tall mark by height.
    const wide = brandImageBox(w, h, 4000, 100)!;
    expect(wide.w).toBeCloseTo(fontSize * 9, 6);
    const tall = brandImageBox(w, h, 64, 512)!;
    expect(tall.h).toBeCloseTo(fontSize * 2.2, 6);
  });

  it('never covers more than 40 percent of a small canvas width', () => {
    const box = brandImageBox(200, 120, 5000, 100)!;
    expect(box.w).toBeLessThanOrEqual(200 * 0.4 + 1e-6);
  });

  it('returns null for a logo or canvas without a size', () => {
    for (const bad of [0, -1, NaN, Infinity * 0]) {
      expect(brandImageBox(1600, 900, bad, 100)).toBeNull();
      expect(brandImageBox(1600, 900, 100, bad)).toBeNull();
      expect(brandImageBox(bad, 900, 100, 100)).toBeNull();
    }
  });

  it('caps a text mark at half the canvas width', () => {
    expect(brandTextMaxWidth(1600)).toBe(800);
    expect(brandTextMaxWidth(10)).toBe(40);
  });
});
