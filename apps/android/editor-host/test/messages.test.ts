import { describe, expect, it } from 'vitest';
import { binaryHeader, binaryMessage, textMessage } from '../src/messages';
import { parseBatch, parseLoad } from '../src/payload';

const ORIGIN = 'https://appassets.androidplatform.net';
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function loadPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'abc-123',
    imageUrl: `${ORIGIN}/capture/abc-123.png`,
    width: 100,
    height: 200,
    licensed: false,
    ...extra,
  };
}

describe('text messages', () => {
  it('are a JSON object with the method in "m" and the arguments next to it', () => {
    const parsed = JSON.parse(textMessage('saveDoc', { id: 'abc-123', doc: '{"version":1}' }));
    expect(parsed).toEqual({ m: 'saveDoc', id: 'abc-123', doc: '{"version":1}' });
  });

  it('carry a call without arguments', () => {
    expect(JSON.parse(textMessage('ready'))).toEqual({ m: 'ready' });
  });

  it('survive text that would break naive string building', () => {
    const text = 'quote " backslash \\ newline \n separator   emoji \u{1F600}';
    expect(JSON.parse(textMessage('copyText', { text })).text).toBe(text);
  });
});

describe('binary messages', () => {
  it('start with the header length as a big-endian u32, then the header, then the image bytes', async () => {
    const image = new Blob([new Uint8Array(PNG_MAGIC)], { type: 'image/png' });
    const buffer = await binaryMessage('saveImage', image, 'image/png', 'polishot-1.png');
    const bytes = new Uint8Array(buffer);

    const length = new DataView(buffer).getUint32(0, false);
    const header = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length)));
    expect(header).toEqual({ m: 'saveImage', mime: 'image/png', filename: 'polishot-1.png' });
    expect(Array.from(bytes.slice(4 + length))).toEqual(PNG_MAGIC);
  });

  it('leave the file name out when there is none', () => {
    const header = JSON.parse(new TextDecoder().decode(binaryHeader('copyImage', 'image/png')));
    expect(header).toEqual({ m: 'copyImage', mime: 'image/png' });
  });

  it('keep the header small enough for the native limit of 2048 bytes', () => {
    const header = binaryHeader('saveImage', 'image/webp', `polishot-20260101-120000-${'9'.repeat(60)}.webp`);
    expect(header.length).toBeLessThan(2048);
  });

  it('do not mangle a non-ASCII file name', async () => {
    const image = new Blob([new Uint8Array(PNG_MAGIC)]);
    const buffer = await binaryMessage('saveImage', image, 'image/png', 'bild-äö.png');
    const length = new DataView(buffer).getUint32(0, false);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer).slice(4, 4 + length)));
    expect(header.filename).toBe('bild-äö.png');
  });
});

describe('the binaryImages announcement from Android', () => {
  it('is false unless Android says true', () => {
    expect(parseLoad(loadPayload(), ORIGIN)?.binaryImages).toBe(false);
    expect(parseLoad(loadPayload({ binaryImages: 'yes' }), ORIGIN)?.binaryImages).toBe(false);
    expect(parseLoad(loadPayload({ binaryImages: true }), ORIGIN)?.binaryImages).toBe(true);
  });

  it('is read from a batch payload too', () => {
    const batch = (extra: Record<string, unknown>) =>
      parseBatch(
        {
          items: [{ id: 'abc-123', imageUrl: `${ORIGIN}/capture/abc-123.png`, width: 10, height: 10 }],
          licensed: false,
          theme: 'light',
          export: { format: 'png', quality: 0.9, scale: 2 },
          ...extra,
        },
        ORIGIN,
      );
    expect(batch({})?.binaryImages).toBe(false);
    expect(batch({ binaryImages: true })?.binaryImages).toBe(true);
  });
});
