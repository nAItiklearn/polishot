import type { EditorDoc, ImageDataLike } from '../src/types';
import { createDoc } from '../src/doc';

export type RGB = [number, number, number];

export function solidImage(width: number, height: number, rgb: RGB = [255, 255, 255]): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return { width, height, data };
}

export function fillRect(img: ImageDataLike, x: number, y: number, w: number, h: number, rgb: RGB): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
}

/** Busy, high-contrast content: diagonal stripes, so no row or column of it is uniform. */
export function fillStripes(img: ImageDataLike, x: number, y: number, w: number, h: number, a: RGB, b: RGB): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const c = ((xx + yy) >> 2) % 2 === 0 ? a : b;
      const i = (yy * img.width + xx) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
}

/** Deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function docFor(width = 800, height = 600, patch: Partial<EditorDoc> = {}): EditorDoc {
  return { ...createDoc({ id: 'img1', width, height }), ...patch };
}
