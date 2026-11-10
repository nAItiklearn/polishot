import { describe, expect, it } from 'vitest';
import { isCaptureUrl, parseBatch, parseExportDefaults, parseLoad, parseNotify, parseWords } from '../src/payload';

const ORIGIN = 'https://appassets.androidplatform.net';
const URL_OK = `${ORIGIN}/capture/m3k9x2ab-9f31c07e.png`;

const load = (over: Record<string, unknown> = {}) => ({
  id: 'm3k9x2ab-9f31c07e',
  imageUrl: URL_OK,
  width: 1080,
  height: 2400,
  licensed: false,
  theme: 'dark',
  ...over,
});

describe('isCaptureUrl', () => {
  it('accepts only the app capture route on the page origin', () => {
    expect(isCaptureUrl(URL_OK, ORIGIN)).toBe(true);
    expect(isCaptureUrl('/capture/abc.png', ORIGIN)).toBe(true);
  });

  it('rejects other origins, paths, queries and schemes', () => {
    for (const bad of [
      'https://evil.example/capture/abc.png',
      `${ORIGIN}/assets/editor/index.html`,
      `${ORIGIN}/capture/abc.png?x=1`,
      `${ORIGIN}/capture/abc.png#x`,
      `${ORIGIN}/capture/../etc.png`,
      `${ORIGIN}/capture/a/b.png`,
      'file:///data/data/app/captures/x.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      `${ORIGIN}/capture/${'a'.repeat(65)}.png`,
      '',
      42,
      null,
    ]) {
      expect(isCaptureUrl(bad, ORIGIN), String(bad)).toBe(false);
    }
  });
});

describe('parseLoad', () => {
  it('accepts a complete payload and fills defaults', () => {
    const p = parseLoad(load(), ORIGIN);
    expect(p).not.toBeNull();
    expect(p?.theme).toBe('dark');
    expect(p?.exportDefaults).toEqual({ format: 'png', quality: 0.92, scale: 2 });
    expect(p?.defaultPreset).toBe('auto');
    expect(p?.quickSendAvailable).toBe(false);
    expect(p?.words).toBeUndefined();
  });

  it('keeps words, document and export defaults', () => {
    const p = parseLoad(
      load({
        words: [{ text: 'hi', box: { x: 1, y: 2, w: 3, h: 4 }, line: 0 }],
        docJson: '{"version":1}',
        exportDefaults: { format: 'webp', quality: 0.5, scale: 3 },
        defaultPreset: 'ig-story',
        quickSendAvailable: true,
      }),
      ORIGIN,
    );
    expect(p?.words).toHaveLength(1);
    expect(p?.docJson).toBe('{"version":1}');
    expect(p?.exportDefaults).toEqual({ format: 'webp', quality: 0.5, scale: 3 });
    expect(p?.defaultPreset).toBe('ig-story');
    expect(p?.quickSendAvailable).toBe(true);
  });

  it('drops payloads with a bad id, url, size, flag or words', () => {
    for (const bad of [
      load({ id: '../x' }),
      load({ id: '' }),
      load({ imageUrl: 'https://evil.example/capture/x.png' }),
      load({ width: 0 }),
      load({ height: 1.5 }),
      load({ width: 70_000 }),
      load({ licensed: 'yes' }),
      load({ words: [{ text: 'x' }] }),
      load({ docJson: 5 }),
      null,
      'text',
      [],
    ]) {
      expect(parseLoad(bad, ORIGIN)).toBeNull();
    }
  });

  it('falls back for unknown theme and preset values', () => {
    const p = parseLoad(load({ theme: 'neon', defaultPreset: 'nope' }), ORIGIN);
    expect(p?.theme).toBe('light');
    expect(p?.defaultPreset).toBe('auto');
  });
});

describe('parseWords', () => {
  const word = { text: 'a@b.co', box: { x: 0, y: 0, w: 10, h: 5 }, line: 2 };

  it('accepts well formed words', () => {
    expect(parseWords([word])).toEqual([word]);
    expect(parseWords([])).toEqual([]);
  });

  it('rejects malformed words as a whole', () => {
    expect(parseWords([{ ...word, text: '' }])).toBeNull();
    expect(parseWords([{ ...word, box: { x: 0, y: 0, w: 0, h: 5 } }])).toBeNull();
    expect(parseWords([{ ...word, box: { x: Number.NaN, y: 0, w: 1, h: 1 } }])).toBeNull();
    expect(parseWords([{ ...word, line: -1 }])).toBeNull();
    expect(parseWords([{ ...word, line: 1.5 }])).toBeNull();
    expect(parseWords('nope')).toBeNull();
    expect(parseWords(new Array(20_001).fill(word))).toBeNull();
  });
});

describe('parseExportDefaults', () => {
  it('clamps quality and normalises format and scale', () => {
    expect(parseExportDefaults({ format: 'jpeg', quality: 5, scale: 9 })).toEqual({ format: 'jpeg', quality: 1, scale: 2 });
    expect(parseExportDefaults({ format: 'gif', quality: 0.1, scale: 1 })).toEqual({ format: 'png', quality: 0.4, scale: 1 });
    expect(parseExportDefaults(undefined)).toEqual({ format: 'png', quality: 0.92, scale: 2 });
  });
});

describe('parseBatch', () => {
  const item = { id: 'a1', imageUrl: `${ORIGIN}/capture/a1.png`, width: 100, height: 200 };

  it('accepts a batch with a look', () => {
    const p = parseBatch({ items: [item], lookJson: '{"padding":0.1}', licensed: false, theme: 'light', export: { format: 'png', quality: 0.9, scale: 2 } }, ORIGIN);
    expect(p?.items).toHaveLength(1);
    expect(p?.lookJson).toBe('{"padding":0.1}');
    expect(p?.export.scale).toBe(2);
  });

  it('rejects empty, oversized or tampered batches', () => {
    expect(parseBatch({ items: [], licensed: false }, ORIGIN)).toBeNull();
    expect(parseBatch({ items: new Array(101).fill(item), licensed: false }, ORIGIN)).toBeNull();
    expect(parseBatch({ items: [{ ...item, imageUrl: 'https://evil.example/x.png' }], licensed: false }, ORIGIN)).toBeNull();
    expect(parseBatch({ items: [item] }, ORIGIN)).toBeNull();
  });
});

describe('parseNotify', () => {
  it('accepts known kinds and truncates long messages', () => {
    expect(parseNotify({ kind: 'saved', message: 'ok' })).toEqual({ kind: 'saved', message: 'ok' });
    expect(parseNotify({ kind: 'error', message: 'x'.repeat(500) })?.message).toHaveLength(200);
  });

  it('rejects unknown kinds and non strings', () => {
    expect(parseNotify({ kind: 'weird', message: 'x' })).toBeNull();
    expect(parseNotify({ kind: 'saved', message: 7 })).toBeNull();
    expect(parseNotify(null)).toBeNull();
  });
});
