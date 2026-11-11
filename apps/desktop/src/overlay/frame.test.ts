import { describe, expect, it } from 'vitest';
import { BMP_PIXEL_OFFSET, bgrxToRgba, isLittleEndian, parseFrameBmp } from './frame';

/** The exact layout `core/src/bmp.rs` writes: 68-byte header, top-down 32-bit BGRX. */
function makeBmp(width: number, height: number, bgrx: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(BMP_PIXEL_OFFSET + width * height * 4);
  const v = new DataView(buf);
  v.setUint8(0, 0x42);
  v.setUint8(1, 0x4d);
  v.setUint32(2, buf.byteLength, true);
  v.setUint32(10, BMP_PIXEL_OFFSET, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, width, true);
  v.setInt32(22, -height, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 32, true);
  v.setUint32(30, 3, true);
  v.setUint32(34, width * height * 4, true);
  v.setUint32(54, 0x00ff0000, true);
  v.setUint32(58, 0x0000ff00, true);
  v.setUint32(62, 0x000000ff, true);
  new Uint8Array(buf, BMP_PIXEL_OFFSET).set(bgrx);
  return buf;
}

describe('frozen frame decoding', () => {
  it('assumes a little-endian engine (every Windows target)', () => {
    expect(isLittleEndian()).toBe(true);
  });

  it('swaps blue and red, forces alpha, and keeps green', () => {
    // Two pixels: B=1 G=2 R=3 X=0, and B=250 G=128 R=7 X=77.
    const px = parseFrameBmp(makeBmp(2, 1, [1, 2, 3, 0, 250, 128, 7, 77]));
    expect(px).not.toBeNull();
    expect(px?.width).toBe(2);
    expect(px?.height).toBe(1);
    expect(Array.from(px?.rgba ?? [])).toEqual([3, 2, 1, 255, 7, 128, 250, 255]);
  });

  it('keeps rows top-down', () => {
    // 1 x 2: top pixel red (BGRX 0,0,255), bottom pixel blue (255,0,0).
    const px = parseFrameBmp(makeBmp(1, 2, [0, 0, 255, 0, 255, 0, 0, 0]));
    expect(Array.from(px?.rgba ?? [])).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it('matches a per-byte reference on a larger buffer', () => {
    const w = 37;
    const h = 11;
    const bgrx: number[] = [];
    for (let i = 0; i < w * h; i++) bgrx.push((i * 7) & 255, (i * 13) & 255, (i * 29) & 255, (i * 31) & 255);
    const px = parseFrameBmp(makeBmp(w, h, bgrx));
    const expected: number[] = [];
    for (let i = 0; i < w * h; i++) expected.push(bgrx[i * 4 + 2]!, bgrx[i * 4 + 1]!, bgrx[i * 4]!, 255);
    expect(Array.from(px?.rgba ?? [])).toEqual(expected);
  });

  it('converts words directly', () => {
    const src = new Uint32Array([0x00112233, 0xff000000, 0x00ffffff]);
    const dst = new Uint32Array(3);
    bgrxToRgba(src, dst);
    // 0x00RRGGBB (as BGRX in memory) becomes 0xFFBBGGRR.
    expect(Array.from(dst, (n) => n.toString(16))).toEqual(['ff332211', 'ff000000', 'ffffffff']);
  });

  it('rejects anything that is not exactly the backend layout', () => {
    const good = makeBmp(2, 2, new Array(16).fill(9));
    expect(parseFrameBmp(good)).not.toBeNull();
    expect(parseFrameBmp(new ArrayBuffer(0))).toBeNull();
    expect(parseFrameBmp(new ArrayBuffer(40))).toBeNull();

    const mutate = (f: (v: DataView) => void) => {
      const copy = good.slice(0);
      f(new DataView(copy));
      return parseFrameBmp(copy);
    };
    expect(mutate((v) => v.setUint8(0, 0x50))).toBeNull(); // not "BM" (a PNG starts with 0x89 P N G)
    expect(mutate((v) => v.setUint32(10, 66, true))).toBeNull(); // unaligned pixel offset
    expect(mutate((v) => v.setUint32(14, 124, true))).toBeNull(); // not a 40-byte info header
    expect(mutate((v) => v.setUint16(28, 24, true))).toBeNull(); // not 32 bits
    expect(mutate((v) => v.setUint32(30, 0, true))).toBeNull(); // not bitfields
    expect(mutate((v) => v.setUint32(54, 0x000000ff, true))).toBeNull(); // another channel order
    expect(mutate((v) => v.setInt32(22, 2, true))).toBeNull(); // bottom-up
    expect(mutate((v) => v.setInt32(18, 0, true))).toBeNull(); // no width
    expect(mutate((v) => v.setInt32(18, 3, true))).toBeNull(); // pixel count disagrees with the size
    // A PNG (the benchmark switch) falls through to the browser decoder.
    const png = new Uint8Array(BMP_PIXEL_OFFSET + 16);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(parseFrameBmp(png.buffer)).toBeNull();
  });
});
