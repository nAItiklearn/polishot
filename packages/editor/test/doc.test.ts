import { describe, expect, it } from 'vitest';
import { LIMITS, createDoc, isSafeImageSrc, newId, nextStepNumber, validateDoc } from '../src/doc';
import type { Annotation, EditorDoc } from '../src/types';

const rect = (id: string): Annotation => ({
  id,
  type: 'rect',
  x: 10,
  y: 20,
  w: 30,
  h: 40,
  color: '#e4572e',
  strokeWidth: 4,
});

function fullDoc(): EditorDoc {
  return {
    version: 1,
    image: { id: 'cap_1', width: 1920, height: 1080 },
    crop: { x: 10, y: 20, w: 1000, h: 500 },
    padding: 0.08,
    background: { type: 'gradient', stops: ['#dcd8d0', '#bfb9ad'], angle: 160 },
    radius: 12,
    shadow: 0.5,
    frame: 'browser-light',
    preset: 'custom',
    custom: { width: 1200, height: 800 },
    annotations: [
      { id: 'a1', type: 'arrow', points: [1, 2, 3, 4], color: '#e4572e', strokeWidth: 4 },
      { id: 'a2', type: 'line', points: [1, 2, 30, 40], color: 'rgb(10, 20, 30)', strokeWidth: 2 },
      { id: 'a3', type: 'rect', x: 10, y: 20, w: 30, h: 40, color: '#e4572e', strokeWidth: 4, fill: true },
      { id: 'a4', type: 'ellipse', x: 1, y: 2, w: 3, h: 4, color: '#fff', strokeWidth: 3 },
      { id: 'a5', type: 'text', x: 5, y: 6, text: '<img src=x onerror=alert(1)> hi', fontSize: 24, color: '#111' },
      { id: 'a6', type: 'step', x: 5, y: 6, n: 3, color: '#e4572e' },
      { id: 'a7', type: 'blur', x: 1, y: 2, w: 100, h: 20, mode: 'pixelate', source: 'auto', kind: 'card' },
      { id: 'a8', type: 'redact-brush', points: [1, 2, 3, 4, 5, 6], size: 24, mode: 'bar' },
    ],
  };
}

describe('createDoc', () => {
  it('creates a balanced default document', () => {
    const d = createDoc({ id: 'x', width: 800, height: 600 });
    expect(d).toMatchObject({
      version: 1,
      image: { id: 'x', width: 800, height: 600 },
      crop: null,
      background: { type: 'auto' },
      frame: 'none',
      preset: 'auto',
      annotations: [],
    });
    expect(d.padding).toBeGreaterThan(0);
    expect(d.padding).toBeLessThanOrEqual(0.3);
    expect(validateDoc(d)).toEqual(d);
  });
});

describe('validateDoc: accepts good documents', () => {
  it('round-trips a document with every annotation type', () => {
    const d = fullDoc();
    expect(validateDoc(d)).toEqual(d);
  });

  it('accepts JSON text', () => {
    const d = fullDoc();
    expect(validateDoc(JSON.stringify(d))).toEqual(d);
  });

  it('keeps the exact text of text annotations (never interprets it)', () => {
    const out = validateDoc(fullDoc())!;
    const t = out.annotations.find((a) => a.type === 'text');
    expect(t && t.type === 'text' && t.text).toBe('<img src=x onerror=alert(1)> hi');
  });

  it('drops unknown keys and clamps soft ranges', () => {
    const d = { ...fullDoc(), padding: 5, shadow: -2, radius: 99999, evil: { x: 1 } } as unknown;
    const out = validateDoc(d)!;
    expect(out.padding).toBe(0.3);
    expect(out.shadow).toBe(0);
    expect(out.radius).toBe(512);
    expect('evil' in out).toBe(false);
  });

  it('clamps the crop to the image bounds', () => {
    const out = validateDoc({ ...fullDoc(), crop: { x: -50, y: 10, w: 5000, h: 100 } })!;
    expect(out.crop).toEqual({ x: 0, y: 10, w: 1920, h: 100 });
  });

  it('strips control characters from text', () => {
    const d = fullDoc();
    (d.annotations[4] as { text: string }).text = 'a\u0000b\u0007c\nd';
    const t = validateDoc(d)!.annotations[4] as { text: string };
    expect(t.text).toBe('abc\nd');
  });

  it('fills a missing custom size when the preset is custom', () => {
    const d = fullDoc() as unknown as Record<string, unknown>;
    delete d.custom;
    expect(validateDoc(d)!.custom).toEqual({ width: 1200, height: 800 });
  });
});

describe('validateDoc: rejects malformed input', () => {
  const bad: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an array', []],
    ['a non-JSON string', 'not json'],
    ['a JSON string holding a number', '7'],
    ['an empty object', {}],
    ['a Map', new Map()],
    ['a Date', new Date()],
    ['wrong version', { ...fullDoc(), version: 2 }],
    ['string version', { ...fullDoc(), version: '1' }],
    ['no image', { ...fullDoc(), image: undefined }],
    ['image width as string', { ...fullDoc(), image: { id: 'a', width: '100', height: 100 } }],
    ['image width NaN', { ...fullDoc(), image: { id: 'a', width: Number.NaN, height: 100 } }],
    ['image width Infinity', { ...fullDoc(), image: { id: 'a', width: Infinity, height: 100 } }],
    ['image width fractional', { ...fullDoc(), image: { id: 'a', width: 10.5, height: 100 } }],
    ['image width zero', { ...fullDoc(), image: { id: 'a', width: 0, height: 100 } }],
    ['image width negative', { ...fullDoc(), image: { id: 'a', width: -5, height: 100 } }],
    ['image too large', { ...fullDoc(), image: { id: 'a', width: 60000, height: 60000 } }],
    ['image id not a string', { ...fullDoc(), image: { id: 5, width: 10, height: 10 } }],
    ['padding NaN', { ...fullDoc(), padding: Number.NaN }],
    ['padding string', { ...fullDoc(), padding: '0.1' }],
    ['padding missing', (() => { const d = fullDoc() as unknown as Record<string, unknown>; delete d.padding; return d; })()],
    ['unknown frame', { ...fullDoc(), frame: 'macos' }],
    ['unknown preset', { ...fullDoc(), preset: 'tiktok' }],
    ['crop with zero size', { ...fullDoc(), crop: { x: 5, y: 5, w: 0, h: 10 } }],
    ['crop outside the image', { ...fullDoc(), crop: { x: 5000, y: 5, w: 10, h: 10 } }],
    ['crop with NaN', { ...fullDoc(), crop: { x: Number.NaN, y: 5, w: 10, h: 10 } }],
    ['custom size out of range', { ...fullDoc(), custom: { width: 1, height: 1 } }],
    ['annotations not an array', { ...fullDoc(), annotations: {} }],
    ['unknown annotation type', { ...fullDoc(), annotations: [{ id: 'a', type: 'script', x: 1 }] }],
    ['annotation is a string', { ...fullDoc(), annotations: ['rect'] }],
    ['annotation with NaN coord', { ...fullDoc(), annotations: [{ ...rect('a'), x: Number.NaN }] }],
    ['annotation with Infinity', { ...fullDoc(), annotations: [{ ...rect('a'), w: Infinity }] }],
    ['annotation with huge coord', { ...fullDoc(), annotations: [{ ...rect('a'), x: 1e12 }] }],
    ['annotation id with spaces', { ...fullDoc(), annotations: [{ ...rect('has space') }] }],
    ['annotation id too long', { ...fullDoc(), annotations: [{ ...rect('a'.repeat(65)) }] }],
    ['duplicate ids', { ...fullDoc(), annotations: [rect('a'), rect('a')] }],
    ['arrow with 3 points', { ...fullDoc(), annotations: [{ id: 'a', type: 'arrow', points: [1, 2, 3], color: '#fff', strokeWidth: 2 }] }],
    ['arrow with NaN point', { ...fullDoc(), annotations: [{ id: 'a', type: 'arrow', points: [1, 2, 3, Number.NaN], color: '#fff', strokeWidth: 2 }] }],
    ['colour is a url()', { ...fullDoc(), annotations: [{ ...rect('a'), color: 'url(javascript:alert(1))' }] }],
    ['colour is a name', { ...fullDoc(), annotations: [{ ...rect('a'), color: 'red' }] }],
    ['colour is not a string', { ...fullDoc(), annotations: [{ ...rect('a'), color: 123 }] }],
    ['colour with a style injection', { ...fullDoc(), annotations: [{ ...rect('a'), color: '#fff; background:url(x)' }] }],
    ['text too long', { ...fullDoc(), annotations: [{ id: 'a', type: 'text', x: 0, y: 0, text: 'x'.repeat(LIMITS.maxText + 1), fontSize: 20, color: '#fff' }] }],
    ['text not a string', { ...fullDoc(), annotations: [{ id: 'a', type: 'text', x: 0, y: 0, text: { toString: 1 }, fontSize: 20, color: '#fff' }] }],
    ['step number zero', { ...fullDoc(), annotations: [{ id: 'a', type: 'step', x: 0, y: 0, n: 0, color: '#fff' }] }],
    ['step number fractional', { ...fullDoc(), annotations: [{ id: 'a', type: 'step', x: 0, y: 0, n: 1.5, color: '#fff' }] }],
    ['blur with zero area', { ...fullDoc(), annotations: [{ id: 'a', type: 'blur', x: 0, y: 0, w: 0, h: 5, mode: 'blur', source: 'manual' }] }],
    ['blur with bad mode', { ...fullDoc(), annotations: [{ id: 'a', type: 'blur', x: 0, y: 0, w: 5, h: 5, mode: 'mosaic', source: 'manual' }] }],
    ['blur with bad kind', { ...fullDoc(), annotations: [{ id: 'a', type: 'blur', x: 0, y: 0, w: 5, h: 5, mode: 'blur', source: 'auto', kind: 'ssn' }] }],
    ['brush with odd point count', { ...fullDoc(), annotations: [{ id: 'a', type: 'redact-brush', points: [1, 2, 3], size: 10, mode: 'bar' }] }],
    ['brush with NaN', { ...fullDoc(), annotations: [{ id: 'a', type: 'redact-brush', points: [1, 2, Number.NaN, 4], size: 10, mode: 'bar' }] }],
    ['brush with a string coordinate', { ...fullDoc(), annotations: [{ id: 'a', type: 'redact-brush', points: [1, 2, '3', 4], size: 10, mode: 'bar' }] }],
    ['gradient with one stop', { ...fullDoc(), background: { type: 'gradient', stops: ['#fff'], angle: 0 } }],
    ['gradient with a bad colour', { ...fullDoc(), background: { type: 'gradient', stops: ['#fff', 'expression(alert(1))'], angle: 0 } }],
    ['unknown background type', { ...fullDoc(), background: { type: 'video' } }],
  ];

  it.each(bad)('rejects %s', (_name, input) => {
    expect(validateDoc(input)).toBeNull();
  });
});

describe('validateDoc: rejects hostile input', () => {
  it('rejects too many annotations', () => {
    const many = Array.from({ length: LIMITS.maxAnnotations + 1 }, (_, i) => rect(`a${i}`));
    expect(validateDoc({ ...fullDoc(), annotations: many })).toBeNull();
  });

  it('accepts exactly the maximum number of annotations', () => {
    const many = Array.from({ length: LIMITS.maxAnnotations }, (_, i) => rect(`a${i}`));
    expect(validateDoc({ ...fullDoc(), annotations: many })).not.toBeNull();
  });

  it('rejects a huge freehand stroke', () => {
    const points = new Array(LIMITS.maxBrushNumbers + 2).fill(1);
    expect(
      validateDoc({ ...fullDoc(), annotations: [{ id: 'a', type: 'redact-brush', points, size: 10, mode: 'bar' }] }),
    ).toBeNull();
  });

  it('rejects a document whose total stroke data exceeds the budget', () => {
    const points = new Array(LIMITS.maxBrushNumbers).fill(1);
    const strokes = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, type: 'redact-brush', points, size: 10, mode: 'bar' }));
    expect(validateDoc({ ...fullDoc(), annotations: strokes })).toBeNull();
  });

  it('rejects absurdly long JSON text without parsing it', () => {
    expect(validateDoc('x'.repeat(LIMITS.maxJsonChars + 1))).toBeNull();
  });

  it('rejects __proto__ keys from JSON.parse and never pollutes Object.prototype', () => {
    const json = '{"__proto__":{"polluted":true},"version":1}';
    expect(validateDoc(json)).toBeNull();
    const text = JSON.stringify(fullDoc()).replace('"version":1', '"version":1,"__proto__":{"polluted":"yes"}');
    expect(validateDoc(text)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects constructor / prototype keys at any depth', () => {
    const nested = fullDoc() as unknown as { annotations: Record<string, unknown>[] };
    Object.defineProperty(nested.annotations[0]!, 'constructor', {
      value: { prototype: { polluted: true } },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(validateDoc(JSON.parse(JSON.stringify(nested)))).toBeNull();

    const d1 = JSON.parse(JSON.stringify(fullDoc()));
    d1.background = { type: 'none', prototype: {} };
    expect(validateDoc(d1)).toBeNull();

    const d2 = JSON.parse(JSON.stringify(fullDoc()));
    d2.image.__proto__ = { x: 1 }; // sets the prototype (not an own key) -> not plain object content
    // Either rejected (own key) or sanitised; in both cases there is no pollution.
    validateDoc(d2);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('rejects deeply nested junk before it can blow the stack', () => {
    let deep: unknown = {};
    for (let i = 0; i < 5000; i++) deep = { a: deep };
    expect(validateDoc({ ...fullDoc(), extra: deep })).toBeNull();
    let arr: unknown = [];
    for (let i = 0; i < 5000; i++) arr = [arr];
    expect(validateDoc({ ...fullDoc(), extra: arr })).toBeNull();
  });

  it('rejects objects with exotic prototypes and throwing getters', () => {
    class Evil {
      version = 1;
    }
    expect(validateDoc(new Evil())).toBeNull();
    const trap = {
      ...fullDoc(),
      get padding(): number {
        throw new Error('boom');
      },
    };
    expect(validateDoc(trap)).toBeNull();
  });

  it('refuses unsafe image background sources', () => {
    const doc = (src: string) => ({ ...fullDoc(), background: { type: 'image', src, blur: 4 } });
    expect(validateDoc(doc('javascript:alert(1)'))).toBeNull();
    expect(validateDoc(doc('file:///etc/passwd'))).toBeNull();
    expect(validateDoc(doc('https://evil.example/track.png'))).toBeNull();
    expect(validateDoc(doc('//evil.example/x.png'))).toBeNull();
    expect(validateDoc(doc('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='))).toBeNull();
    expect(validateDoc(doc('data:text/html;base64,PGgxPg=='))).toBeNull();
    expect(validateDoc(doc(''))).toBeNull();
  });

  it('accepts data:, blob: and host-allowed image sources', () => {
    const doc = (src: string) => ({ ...fullDoc(), background: { type: 'image', src, blur: 4 } });
    expect(validateDoc(doc('data:image/png;base64,iVBORw0KGgo='))).not.toBeNull();
    expect(validateDoc(doc('data:image/jpeg;base64,/9j/4AAQ'))).not.toBeNull();
    expect(validateDoc(doc('blob:https://app.example/1234-5678'))).not.toBeNull();
    expect(
      validateDoc(doc('https://appassets.androidplatform.net/capture/x.png'), {
        origins: ['https://appassets.androidplatform.net'],
      }),
    ).not.toBeNull();
    expect(
      validateDoc(doc('https://evil.example/x.png'), { origins: ['https://appassets.androidplatform.net'] }),
    ).toBeNull();
  });
});

describe('isSafeImageSrc', () => {
  it('only allows the documented schemes', () => {
    expect(isSafeImageSrc('data:image/webp;base64,AAAA')).toBe(true);
    expect(isSafeImageSrc('blob:http://x/abc')).toBe(true);
    expect(isSafeImageSrc('https://example.com/a.png')).toBe(false);
    expect(isSafeImageSrc('https://example.com/a.png', ['https://example.com'])).toBe(true);
    expect(isSafeImageSrc('https://example.com.evil.net/a.png', ['https://example.com'])).toBe(false);
    expect(isSafeImageSrc('http://example.com/a.png', ['https://example.com'])).toBe(false);
    expect(isSafeImageSrc('ftp://example.com/a.png', ['ftp://example.com'])).toBe(false);
    expect(isSafeImageSrc(42)).toBe(false);
    expect(isSafeImageSrc('relative/path.png')).toBe(false);
  });
});

describe('helpers', () => {
  it('newId produces unique ids that pass validation', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId('a')));
    expect(ids.size).toBe(2000);
    const doc = { ...fullDoc(), annotations: [...ids].slice(0, 50).map((id) => rect(id)) };
    expect(validateDoc(doc)).not.toBeNull();
  });

  it('numbered steps auto-increment and reuse gaps', () => {
    const step = (n: number): Annotation => ({ id: `s${n}`, type: 'step', x: 0, y: 0, n, color: '#000' });
    expect(nextStepNumber([])).toBe(1);
    expect(nextStepNumber([step(1)])).toBe(2);
    expect(nextStepNumber([step(1), step(2), step(3)])).toBe(4);
    expect(nextStepNumber([step(1), step(3)])).toBe(2);
    expect(nextStepNumber([rect('a'), step(2)])).toBe(1);
  });
});
