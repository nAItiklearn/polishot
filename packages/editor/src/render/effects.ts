import Konva from 'konva';
import type { Rect } from '../types';

/** Largest side, in px, of a canvas used for a pixel effect. */
const MAX_SIDE = 8192;
/** Effects on regions bigger than this many pixels are computed at a reduced resolution. */
const MAX_EFFECT_PIXELS = 1_600_000;

export type PixelSource = CanvasImageSource;

type KonvaFilterFn = (this: Konva.Node, imageData: ImageData, pixelRatio?: number) => void;

export interface RegionCanvas {
  canvas: HTMLCanvasElement;
  /** Source-space rectangle (integers) the canvas covers. */
  rect: Rect;
  /** Canvas pixels per source pixel. */
  scale: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Snaps a rectangle outward to whole pixels. */
export function snapOut(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.max(1, Math.ceil(r.x + r.w) - x), h: Math.max(1, Math.ceil(r.y + r.h) - y) };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 - x0 > 0 && y1 - y0 > 0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function inflate(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

/** Resolution factor for an effect on a region of the given size. */
export function effectResolution(w: number, h: number): number {
  const px = w * h;
  return px > MAX_EFFECT_PIXELS ? Math.sqrt(MAX_EFFECT_PIXELS / px) : 1;
}

/**
 * Copies `rect` (source px, snapped to integers) of the source image into a new canvas. Parts of the
 * rectangle that fall outside the image are filled by repeating the nearest edge pixel, so blurring near
 * an image edge never fades towards transparent (which would leak the sharp pixels underneath).
 */
export function regionCanvas(
  src: PixelSource,
  imgW: number,
  imgH: number,
  rectIn: Rect,
  scale = 1,
): RegionCanvas | null {
  const rect = snapOut(rectIn);
  const cw = Math.round(rect.w * scale);
  const ch = Math.round(rect.h * scale);
  if (cw < 1 || ch < 1 || cw > MAX_SIDE || ch > MAX_SIDE) return null;
  const canvas = makeCanvas(cw, ch);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = scale < 1;
  if (scale < 1) ctx.imageSmoothingQuality = 'high';

  const sx0 = clamp(rect.x, 0, imgW);
  const sx1 = clamp(rect.x + rect.w, 0, imgW);
  const sy0 = clamp(rect.y, 0, imgH);
  const sy1 = clamp(rect.y + rect.h, 0, imgH);
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  if (sw <= 0 || sh <= 0) return null;
  const dx = (x: number) => (x - rect.x) * scale;
  const dy = (y: number) => (y - rect.y) * scale;

  ctx.drawImage(src, sx0, sy0, sw, sh, dx(sx0), dy(sy0), sw * scale, sh * scale);

  const left = sx0 - rect.x;
  const right = rect.x + rect.w - sx1;
  const top = sy0 - rect.y;
  const bottom = rect.y + rect.h - sy1;
  const edge = (sxs: number, sys: number, sws: number, shs: number, x: number, y: number, w: number, h: number) => {
    if (w > 0 && h > 0) ctx.drawImage(src, sxs, sys, sws, shs, dx(x), dy(y), w * scale, h * scale);
  };
  if (left > 0) edge(sx0, sy0, 1, sh, rect.x, sy0, left, sh);
  if (right > 0) edge(sx1 - 1, sy0, 1, sh, sx1, sy0, right, sh);
  if (top > 0) edge(sx0, sy0, sw, 1, sx0, rect.y, sw, top);
  if (bottom > 0) edge(sx0, sy1 - 1, sw, 1, sx0, sy1, sw, bottom);
  if (left > 0 && top > 0) edge(sx0, sy0, 1, 1, rect.x, rect.y, left, top);
  if (right > 0 && top > 0) edge(sx1 - 1, sy0, 1, 1, sx1, rect.y, right, top);
  if (left > 0 && bottom > 0) edge(sx0, sy1 - 1, 1, 1, rect.x, sy1, left, bottom);
  if (right > 0 && bottom > 0) edge(sx1 - 1, sy1 - 1, 1, 1, sx1, sy1, right, bottom);
  return { canvas, rect, scale };
}

/** Runs one of Konva's pixel filters (the same code `node.filters([...])` uses) over a whole canvas, in place. */
export function applyKonvaFilter(canvas: HTMLCanvasElement, mode: 'blur' | 'pixelate', amount: number): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Konva filters read their parameters through node getters; a plain object with those getters is enough.
  const holder = { blurRadius: () => amount, pixelSize: () => amount } as unknown as Konva.Node;
  const filter = (mode === 'blur' ? Konva.Filters.Blur : Konva.Filters.Pixelate) as unknown as KonvaFilterFn;
  filter.call(holder, data, 1);
  ctx.putImageData(data, 0, 0);
}

/**
 * Builds the displayed bitmap for a blur/pixelate annotation: the visible source region with the effect
 * applied. The effect is computed on a larger, edge-extended canvas so the visible part never fades at
 * its borders. Returns a canvas covering exactly `visible` (snapped to whole source px).
 */
export function buildEffectBitmap(
  src: PixelSource,
  imgW: number,
  imgH: number,
  visible: Rect,
  mode: 'blur' | 'pixelate',
  amount: number,
): RegionCanvas | null {
  const vis = snapOut(visible);
  const margin = mode === 'blur' ? Math.ceil(amount * 2) : Math.ceil(amount);
  const ext = inflate(vis, margin);
  const scale = effectResolution(ext.w, ext.h);
  const region = regionCanvas(src, imgW, imgH, ext, scale);
  if (!region) return null;
  applyKonvaFilter(region.canvas, mode, Math.max(1, Math.round(amount * scale)));

  const out = makeCanvas(vis.w * scale, vis.h * scale);
  const octx = out.getContext('2d');
  if (!octx) return null;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(
    region.canvas,
    (vis.x - region.rect.x) * scale,
    (vis.y - region.rect.y) * scale,
    out.width,
    out.height,
    0,
    0,
    out.width,
    out.height,
  );
  return { canvas: out, rect: vis, scale };
}

/** Like buildEffectBitmap but keeps only the pixels under a freehand stroke. */
export function buildBrushBitmap(
  src: PixelSource,
  imgW: number,
  imgH: number,
  visible: Rect,
  points: readonly number[],
  size: number,
  blurRadius: number,
): RegionCanvas | null {
  const base = buildEffectBitmap(src, imgW, imgH, visible, 'blur', blurRadius);
  if (!base) return null;
  const ctx = base.canvas.getContext('2d');
  if (!ctx) return null;
  const k = base.scale;

  // Draw the stroke (and a dot at its start, so a click still covers something) on a separate mask, then
  // cut the blurred bitmap down to it in one step. Two successive destination-in passes would intersect.
  const mask = makeCanvas(base.canvas.width, base.canvas.height);
  const mctx = mask.getContext('2d');
  if (!mctx) return null;
  mctx.lineCap = 'round';
  mctx.lineJoin = 'round';
  mctx.lineWidth = size * k;
  mctx.strokeStyle = '#000';
  mctx.fillStyle = '#000';
  const px = (i: number) => (points[i]! - base.rect.x) * k;
  const py = (i: number) => (points[i + 1]! - base.rect.y) * k;
  if (points.length >= 4) {
    mctx.beginPath();
    mctx.moveTo(px(0), py(0));
    for (let i = 2; i + 1 < points.length; i += 2) mctx.lineTo(px(i), py(i));
    mctx.stroke();
  }
  mctx.beginPath();
  mctx.arc(px(0), py(0), (size * k) / 2, 0, Math.PI * 2);
  mctx.fill();

  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
  return base;
}
