import { newId } from './doc';
import type { Annotation, BlurMode, Detection } from './types';

/**
 * Maps OCR detections to blur annotations. Detection boxes are already in source-image pixels, so they
 * are used as-is: one annotation per box, tagged `source: 'auto'` with the detection kind.
 */
export function redactionsFromDetections(dets: readonly Detection[], mode: 'blur' | 'bar'): Annotation[] {
  const out: Annotation[] = [];
  for (const det of dets) {
    for (const b of det.boxes) {
      if (!(b.w > 0) || !(b.h > 0)) continue;
      out.push({
        id: newId('r'),
        type: 'blur',
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        mode,
        source: 'auto',
        kind: det.kind,
      });
    }
  }
  return out;
}

export interface EffectParams {
  /** Gaussian-style blur radius in source px. */
  blurRadius: number;
  /** Mosaic cell size in source px. */
  pixelSize: number;
}

/**
 * Effect strength derived from the region size, so a redaction is always strong enough to make the text
 * underneath unreadable regardless of resolution: the radius is about half the region's short side
 * (typically the text height), never below 8 px.
 */
export function effectParams(w: number, h: number): EffectParams {
  const base = Math.max(1, Math.min(w, h));
  return {
    blurRadius: Math.min(48, Math.max(8, Math.round(base * 0.5))),
    pixelSize: Math.min(64, Math.max(8, Math.round(base / 2.5))),
  };
}

/** Blur radius for a freehand redact brush of the given diameter (source px). */
export function brushBlurRadius(size: number): number {
  return Math.min(48, Math.max(8, Math.round(size * 0.5)));
}

export function isEffectMode(mode: BlurMode): mode is 'blur' | 'pixelate' {
  return mode === 'blur' || mode === 'pixelate';
}

/** Axis-aligned bounds of a freehand stroke including the brush radius: [x, y, w, h]. */
export function strokeBounds(points: readonly number[], size: number): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  const r = size / 2;
  return { x: minX - r, y: minY - r, w: maxX - minX + size, h: maxY - minY + size };
}
