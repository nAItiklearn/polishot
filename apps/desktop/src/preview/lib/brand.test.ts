// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { BRAND_STORAGE_KEY, MAX_BRAND_IMAGE_BYTES, checkBrandImage, loadBrandMark, saveBrandMark, type KeyValueStore } from './brand';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const PNG_DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('brand mark storage (Pro)', () => {
  let store: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    store = memoryStore();
  });

  it('round-trips a text mark', () => {
    expect(saveBrandMark(store, { type: 'text', text: 'maya.dev' })).toBe(true);
    expect(loadBrandMark(store)).toEqual({ type: 'text', text: 'maya.dev' });
  });

  it('round-trips an inline image mark', () => {
    expect(saveBrandMark(store, { type: 'image', src: PNG_DOT })).toBe(true);
    expect(loadBrandMark(store)).toEqual({ type: 'image', src: PNG_DOT });
  });

  it('clears with null', () => {
    saveBrandMark(store, { type: 'text', text: 'x' });
    expect(saveBrandMark(store, null)).toBe(true);
    expect(store.data.has(BRAND_STORAGE_KEY)).toBe(false);
    expect(loadBrandMark(store)).toBeNull();
  });

  it('refuses marks the editor would refuse', () => {
    expect(saveBrandMark(store, { type: 'text', text: '   ' })).toBe(false);
    expect(saveBrandMark(store, { type: 'image', src: 'https://evil.example/logo.png' })).toBe(false);
    expect(saveBrandMark(store, { type: 'image', src: 'data:image/svg+xml;base64,PHN2Zy8+' })).toBe(false);
    expect(saveBrandMark(store, { type: 'image', src: 'javascript:alert(1)' })).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it('cleans stored text on the way in and the way out', () => {
    expect(saveBrandMark(store, { type: 'text', text: `  a\u202eb\n${'c'.repeat(80)}  ` })).toBe(true);
    const mark = loadBrandMark(store);
    expect(mark?.type).toBe('text');
    if (mark?.type === 'text') {
      expect(mark.text.length).toBeLessThanOrEqual(40);
      expect(mark.text).not.toMatch(/[\u202e\n]/);
    }
  });

  it('treats corrupt or tampered storage as no mark', () => {
    for (const bad of ['', 'nope', '{', '[]', '"x"', '{"type":"image","src":"file:///C:/secret.png"}', '{"type":"text"}']) {
      store.data.set(BRAND_STORAGE_KEY, bad);
      expect(loadBrandMark(store)).toBeNull();
    }
  });

  it('survives storage that throws (disabled or full)', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadBrandMark(broken)).toBeNull();
    expect(saveBrandMark(broken, { type: 'text', text: 'x' })).toBe(false);
    expect(loadBrandMark(null)).toBeNull();
    expect(saveBrandMark(undefined, { type: 'text', text: 'x' })).toBe(false);
  });
});

describe('logo file checks', () => {
  it('accepts small raster images', () => {
    expect(checkBrandImage({ type: 'image/png', size: 12_000 })).toBeNull();
    expect(checkBrandImage({ type: 'image/jpeg', size: MAX_BRAND_IMAGE_BYTES })).toBeNull();
    expect(checkBrandImage({ type: 'image/webp', size: 1 })).toBeNull();
  });

  it('rejects SVG, other types, empty and oversized files, with a reason', () => {
    expect(checkBrandImage({ type: 'image/svg+xml', size: 100 })).toMatch(/PNG, JPEG or WebP/);
    expect(checkBrandImage({ type: 'application/pdf', size: 100 })).toMatch(/PNG, JPEG or WebP/);
    expect(checkBrandImage({ type: 'image/png', size: MAX_BRAND_IMAGE_BYTES + 1 })).toMatch(/smaller/);
    expect(checkBrandImage({ type: 'image/png', size: 0 })).toMatch(/empty/);
  });
});
