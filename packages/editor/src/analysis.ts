import { NEUTRAL_STOPS, autoBackground, autoBalance, paddingFor } from './balance';
import type { Background, Box, ImageSource } from './types';

export interface Analysis {
  /** Where the time went, for diagnostics (milliseconds). */
  timings?: { readMs: number; balanceMs: number; backgroundMs: number };
  crop: Box | null;
  padding: number;
  background: Background;
}

/** The analysed copy is at most this many px on its longest side (and more than half of it). */
const ANALYSIS_MAX = 1600;

function canvasOf(w: number, h: number, willReadFrequently: boolean) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently });
  return ctx ? { canvas, ctx } : null;
}

/**
 * Reads the image as pixels, shrunk by repeated exact halving until it fits ANALYSIS_MAX. Every halving at
 * 'low' quality is an exact 2x2 average, so thin lines are blended rather than skipped, and it avoids the
 * very slow 'high' quality resampler (roughly 6x slower on 4K screenshots).
 */
function readDownscaled(image: ImageSource): { pixels: ImageData; width: number; height: number } {
  let source: CanvasImageSource = image.element;
  let w = image.width;
  let h = image.height;
  while (Math.max(w, h) > ANALYSIS_MAX) {
    const nw = Math.max(1, Math.round(w / 2));
    const nh = Math.max(1, Math.round(h / 2));
    const c = canvasOf(nw, nh, true);
    if (!c) throw new Error('canvas unavailable');
    c.ctx.imageSmoothingEnabled = true;
    c.ctx.imageSmoothingQuality = 'low';
    c.ctx.drawImage(source, 0, 0, nw, nh);
    source = c.canvas;
    w = nw;
    h = nh;
  }
  // After at least one halving the source is already one of our CPU-backed canvases; otherwise copy it into one.
  const shrunk = source !== image.element;
  const copy = shrunk ? null : canvasOf(w, h, true);
  copy?.ctx.drawImage(source, 0, 0, w, h);
  const ctx = copy ? copy.ctx : (source as HTMLCanvasElement).getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas unavailable');
  return { pixels: ctx.getImageData(0, 0, w, h), width: w, height: h };
}

/**
 * Reads a downscaled copy of the screenshot and runs auto-balance and the auto background on it. The crop
 * is mapped back to source pixels conservatively (rounded outward), so content is never cut. Work is
 * bounded by the analysis size, not the screenshot size, which keeps 4K captures fast.
 */
export function analyzeImage(image: ImageSource): Analysis {
  const fallback: Analysis = {
    crop: null,
    padding: paddingFor(image.width, image.height),
    background: { type: 'auto', stops: NEUTRAL_STOPS },
  };
  try {
    const t0 = performance.now();
    const { pixels, width: w, height: h } = readDownscaled(image);
    const t1 = performance.now();
    const balance = autoBalance(pixels);
    const t3 = performance.now();
    let crop: Box | null = null;
    if (balance.crop) {
      const sx = image.width / w;
      const sy = image.height / h;
      const x0 = Math.max(0, Math.floor(balance.crop.x * sx));
      const y0 = Math.max(0, Math.floor(balance.crop.y * sy));
      const x1 = Math.min(image.width, Math.ceil((balance.crop.x + balance.crop.w) * sx));
      const y1 = Math.min(image.height, Math.ceil((balance.crop.y + balance.crop.h) * sy));
      if (x1 - x0 >= 1 && y1 - y0 >= 1 && (x0 > 0 || y0 > 0 || x1 < image.width || y1 < image.height)) {
        crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
    }
    const background = autoBackground(pixels, balance.crop);
    const t4 = performance.now();
    const cw = crop ? crop.w : image.width;
    const ch = crop ? crop.h : image.height;
    return {
      crop,
      padding: paddingFor(cw, ch),
      background,
      timings: { readMs: t1 - t0, balanceMs: t3 - t1, backgroundMs: t4 - t3 },
    };
  } catch {
    // Tainted or unreadable canvas: keep the image as-is with a neutral backdrop.
    return fallback;
  }
}
