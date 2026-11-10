import { APP_SLUG } from '@polishot/brand';
import { describe, expect, it } from 'vitest';
import { stripDataUrlPrefix } from '../src/base64';
import { batchLimit, canSaveAnotherLook, FREE_BATCH_IMAGES, FREE_SAVED_LOOKS, MAX_SAVED_LOOKS } from '../src/limits';
import { lookToPatch } from '../src/look';
import { exportFileName } from '../src/naming';

describe('stripDataUrlPrefix', () => {
  it('removes the data URL header and leaves plain base64 alone', () => {
    expect(stripDataUrlPrefix('data:image/png;base64,iVBORw0KGgo=')).toBe('iVBORw0KGgo=');
    expect(stripDataUrlPrefix('data:;base64,AAAA')).toBe('AAAA');
    expect(stripDataUrlPrefix('iVBORw0KGgo=')).toBe('iVBORw0KGgo=');
  });
});

describe('free tier limits (CONTRACTS 5b)', () => {
  it('Free keeps 3 saved looks and Pro keeps many more', () => {
    expect(FREE_SAVED_LOOKS).toBe(3);
    expect(canSaveAnotherLook(0, false)).toBe(true);
    expect(canSaveAnotherLook(2, false)).toBe(true);
    expect(canSaveAnotherLook(3, false)).toBe(false);
    expect(canSaveAnotherLook(3, true)).toBe(true);
    expect(canSaveAnotherLook(MAX_SAVED_LOOKS, true)).toBe(false);
  });

  it('Free batches 5 images, Pro has only the technical ceiling', () => {
    expect(FREE_BATCH_IMAGES).toBe(5);
    expect(batchLimit(false)).toBe(5);
    expect(batchLimit(true)).toBe(100);
  });
});

describe('lookToPatch', () => {
  it('keeps the styling fields', () => {
    const patch = lookToPatch(
      JSON.stringify({ padding: 0.1, radius: 16, shadow: 0.6, frame: 'window', preset: 'x', background: { type: 'solid', color: '#ffffff' } }),
    );
    expect(patch).toEqual({
      padding: 0.1,
      radius: 16,
      shadow: 0.6,
      frame: 'window',
      preset: 'x',
      background: { type: 'solid', color: '#ffffff' },
    });
  });

  it('never copies an auto background (its colours belong to the previous image)', () => {
    const patch = lookToPatch(JSON.stringify({ padding: 0.1, background: { type: 'auto', color: '#112233', stops: ['#112233', '#223344'] } }));
    expect(patch).toEqual({ padding: 0.1 });
  });

  it('only keeps a custom size when the preset is custom', () => {
    expect(lookToPatch(JSON.stringify({ preset: 'x', custom: { width: 10, height: 10 } }))).toEqual({ preset: 'x' });
    expect(lookToPatch(JSON.stringify({ preset: 'custom', custom: { width: 800, height: 600 } }))).toEqual({
      preset: 'custom',
      custom: { width: 800, height: 600 },
    });
  });

  it('ignores junk', () => {
    expect(lookToPatch(undefined)).toBeNull();
    expect(lookToPatch('not json')).toBeNull();
    expect(lookToPatch('[]')).toBeNull();
    expect(lookToPatch('{}')).toBeNull();
    expect(lookToPatch(JSON.stringify({ padding: 'wide', radius: Number.NaN }))).toBeNull();
    expect(lookToPatch('x'.repeat(500_000))).toBeNull();
  });
});

describe('exportFileName', () => {
  it('uses the brand slug, a local timestamp and the right extension', () => {
    const name = exportFileName('jpeg', '-02', new Date(2026, 0, 5, 9, 8, 7));
    expect(name).toBe(`${APP_SLUG}-20260105-090807-02.jpg`);
    expect(exportFileName('png', '', new Date(2026, 11, 31, 23, 59, 59))).toBe(`${APP_SLUG}-20261231-235959.png`);
    expect(exportFileName('webp', '', new Date(2026, 0, 1, 0, 0, 0))).toMatch(/\.webp$/);
  });
});
