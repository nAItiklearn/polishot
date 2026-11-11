/**
 * Loading the frozen screen into the overlay without the browser's image decoder.
 *
 * The backend serves each monitor's grab as an uncompressed 32-bit BMP (`core/src/bmp.rs`): a
 * 68-byte header followed by top-down BGRX pixels, the pixel data starting on a 4-byte boundary.
 * Chromium needs about 400 ms to decode a 4K BMP through `<img>`, and that work blocks showing the
 * overlay. Here the header is read directly, the pixels are swapped from BGRX to RGBA a word at a
 * time and drawn with `putImageData`: tens of milliseconds, and the bytes are already in memory.
 */

/** Where the pixels start in the BMP the backend writes (`bmp::HEADER_LEN`). */
export const BMP_PIXEL_OFFSET = 68;

export interface FramePixels {
  width: number;
  height: number;
  /** Tightly packed RGBA, alpha 255. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** Whether this JavaScript engine stores `Uint32Array` words little-endian (every Windows target). */
export function isLittleEndian(): boolean {
  return new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
}

/** BGRX words (blue in the lowest byte) to opaque RGBA words, in place of per-byte copies. */
export function bgrxToRgba(src: Uint32Array, dst: Uint32Array): void {
  const n = Math.min(src.length, dst.length);
  for (let i = 0; i < n; i++) {
    const p = src[i]!;
    dst[i] = (p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff) | 0xff000000;
  }
}

/**
 * Reads the backend's frame BMP. Returns null for anything that is not exactly that layout (a PNG
 * from the benchmark switch, a different build): the caller then falls back to the browser decoder.
 */
export function parseFrameBmp(buf: ArrayBuffer): FramePixels | null {
  if (buf.byteLength < BMP_PIXEL_OFFSET || !isLittleEndian()) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== 0x42 || v.getUint8(1) !== 0x4d) return null; // "BM"
  const offset = v.getUint32(10, true);
  const infoSize = v.getUint32(14, true);
  const width = v.getInt32(18, true);
  const height = v.getInt32(22, true); // negative: top-down
  const planes = v.getUint16(26, true);
  const bits = v.getUint16(28, true);
  const compression = v.getUint32(30, true);
  const masks = [v.getUint32(54, true), v.getUint32(58, true), v.getUint32(62, true)];
  if (offset !== BMP_PIXEL_OFFSET || infoSize !== 40 || planes !== 1 || bits !== 32) return null;
  if (compression !== 3 || masks[0] !== 0x00ff0000 || masks[1] !== 0x0000ff00 || masks[2] !== 0x000000ff) return null;
  if (width <= 0 || height >= 0) return null;
  const rows = -height;
  const count = width * rows;
  if (!Number.isSafeInteger(count) || count <= 0 || offset + count * 4 !== buf.byteLength) return null;

  const out = new Uint32Array(count);
  bgrxToRgba(new Uint32Array(buf, offset, count), out);
  return { width, height: rows, rgba: new Uint8ClampedArray(out.buffer) };
}

/**
 * Fetch `url` and draw it into `canvas`, sizing the canvas to the image. The request is made as
 * soon as the overlay is armed, usually before the backend has finished grabbing the screen; the
 * server holds it until the frame exists.
 */
export async function loadFrame(url: string, canvas: HTMLCanvasElement): Promise<void> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('The frozen screen could not be loaded.');
  const buf = await response.arrayBuffer();
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('The frozen screen could not be drawn.');

  const pixels = parseFrameBmp(buf);
  if (pixels) {
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    ctx.putImageData(new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
    return;
  }
  // Another format: let the browser decode it (off the main thread).
  const type = response.headers.get('content-type') ?? 'image/bmp';
  const bitmap = await createImageBitmap(new Blob([buf], { type }));
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
}
