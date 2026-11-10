import { LIMITS, newId, nextStepNumber } from './doc';
import type { Annotation, BlurMode, Style, Tool } from './types';

export interface Point {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Annotation colours offered by the UI. */
export const ANNOTATION_COLORS = ['#e4572e', '#1b1b1a', '#ffffff', '#f2b134', '#3f9d63', '#2f6fdb'] as const;

export function defaultStyleFor(imageW: number, imageH: number): Style {
  const m = Math.max(imageW, imageH, 1);
  return {
    color: ANNOTATION_COLORS[0],
    strokeWidth: clamp(Math.round(m / 320), 3, 16),
    fontSize: clamp(Math.round(m / 55), 16, 96),
    blurMode: 'blur' as BlurMode,
    brushSize: 28,
    brushMode: 'blur',
  };
}

/** Radius of a numbered step marker in source px. */
export function stepRadius(imageW: number, imageH: number): number {
  return Math.round(clamp(Math.max(imageW, imageH) * 0.011, 11, 40));
}

/** Snaps the vector a->b to the nearest multiple of 45 degrees (Shift while drawing a line or arrow). */
export function snapAngle(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { ...b };
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

/**
 * Builds the annotation for a drag from `a` to `b` (source px). Returns null for tools that are not drag
 * shapes. Rectangles are normalised to a positive size; Shift constrains to a square / 45 degree angles.
 */
export function buildDragShape(
  tool: Tool,
  a: Point,
  b: Point,
  style: Style,
  shift: boolean,
  id: string,
): Annotation | null {
  switch (tool) {
    case 'arrow':
    case 'line': {
      const end = shift ? snapAngle(a, b) : b;
      return { id, type: tool, points: [a.x, a.y, end.x, end.y], color: style.color, strokeWidth: style.strokeWidth };
    }
    case 'rect':
    case 'ellipse':
    case 'blur': {
      let w = b.x - a.x;
      let h = b.y - a.y;
      if (shift && tool !== 'blur') {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      const x = w >= 0 ? a.x : a.x + w;
      const y = h >= 0 ? a.y : a.y + h;
      const aw = Math.abs(w);
      const ah = Math.abs(h);
      if (tool === 'blur') {
        return { id, type: 'blur', x, y, w: aw, h: ah, mode: style.blurMode, source: 'manual' };
      }
      return { id, type: tool, x, y, w: aw, h: ah, color: style.color, strokeWidth: style.strokeWidth };
    }
    default:
      return null;
  }
}

/** True when a finished drag is big enough to keep (guards against accidental clicks). */
export function isMeaningful(ann: Annotation, minSize: number): boolean {
  switch (ann.type) {
    case 'arrow':
    case 'line':
      return Math.hypot(ann.points[2] - ann.points[0], ann.points[3] - ann.points[1]) >= minSize;
    case 'rect':
    case 'ellipse':
    case 'blur':
      return ann.w >= minSize && ann.h >= minSize;
    case 'redact-brush':
      return ann.points.length >= 2;
    default:
      return true;
  }
}

/** Drops points closer than `minDist` to the previous kept point; always keeps the last point. */
export function thinStroke(points: readonly number[], minDist: number): number[] {
  if (points.length <= 4) return [...points];
  const out: number[] = [points[0]!, points[1]!];
  let lx = points[0]!;
  let ly = points[1]!;
  for (let i = 2; i + 1 < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const last = i + 3 >= points.length;
    if (last || Math.hypot(x - lx, y - ly) >= minDist) {
      out.push(x, y);
      lx = x;
      ly = y;
    }
  }
  return out;
}

/** Thins a stroke progressively until it fits the document limit for a single stroke. */
export function capStroke(points: readonly number[], maxNumbers = LIMITS.maxBrushNumbers): number[] {
  let out = [...points];
  let dist = 1;
  while (out.length > maxNumbers && dist < 1e6) {
    out = thinStroke(out, dist);
    dist *= 2;
  }
  return out.length > maxNumbers ? out.slice(0, maxNumbers - (maxNumbers % 2)) : out;
}

/** Moves every coordinate of an annotation by (dx, dy). */
export function translateAnnotation(ann: Annotation, dx: number, dy: number): Annotation {
  switch (ann.type) {
    case 'arrow':
    case 'line':
      return { ...ann, points: [ann.points[0] + dx, ann.points[1] + dy, ann.points[2] + dx, ann.points[3] + dy] };
    case 'redact-brush': {
      const points = ann.points.map((v, i) => v + (i % 2 === 0 ? dx : dy));
      return { ...ann, points };
    }
    default:
      return { ...ann, x: ann.x + dx, y: ann.y + dy };
  }
}

/** Bounding box of an annotation in source px (strokes not included). */
export function annotationBounds(ann: Annotation, imageW: number, imageH: number): { x: number; y: number; w: number; h: number } {
  switch (ann.type) {
    case 'arrow':
    case 'line': {
      const [x1, y1, x2, y2] = ann.points;
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
    case 'rect':
    case 'ellipse':
    case 'blur':
      return { x: ann.x, y: ann.y, w: ann.w, h: ann.h };
    case 'step': {
      const r = stepRadius(imageW, imageH);
      return { x: ann.x - r, y: ann.y - r, w: r * 2, h: r * 2 };
    }
    case 'text':
      return { x: ann.x, y: ann.y, w: ann.text.length * ann.fontSize * 0.55, h: ann.fontSize * 1.25 };
    case 'redact-brush': {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i + 1 < ann.points.length; i += 2) {
        minX = Math.min(minX, ann.points[i]!);
        maxX = Math.max(maxX, ann.points[i]!);
        minY = Math.min(minY, ann.points[i + 1]!);
        maxY = Math.max(maxY, ann.points[i + 1]!);
      }
      return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 };
    }
  }
}

/**
 * Numbers the steps 1..k in their current order (by number, then by position in the list), so deleting
 * one renumbers the rest. Returns the same array when nothing changes.
 */
export function renumberSteps(annotations: readonly Annotation[]): Annotation[] {
  const steps = annotations
    .map((a, i) => ({ a, i }))
    .filter((e): e is { a: Extract<Annotation, { type: 'step' }>; i: number } => e.a.type === 'step')
    .sort((p, q) => p.a.n - q.a.n || p.i - q.i);
  const next = new Map<string, number>();
  steps.forEach((e, k) => next.set(e.a.id, k + 1));
  let changed = false;
  const out = annotations.map((a) => {
    if (a.type !== 'step') return a;
    const n = next.get(a.id) ?? a.n;
    if (n === a.n) return a;
    changed = true;
    return { ...a, n };
  });
  return changed ? out : [...annotations];
}

/**
 * A copy of `ann` moved by (dx, dy) with a fresh id, ready to be appended after the original. Steps take
 * the next free number; a duplicated automatic redaction becomes a manual one (it no longer belongs to a
 * detection).
 */
export function duplicateAnnotation(ann: Annotation, all: readonly Annotation[], dx: number, dy: number): Annotation {
  const moved = translateAnnotation(ann, dx, dy);
  switch (moved.type) {
    case 'step':
      return { ...moved, id: newId('s'), n: nextStepNumber(all) };
    case 'blur': {
      const { kind: _kind, ...rest } = moved;
      return { ...rest, id: newId('a'), source: 'manual' };
    }
    case 'text':
      return { ...moved, id: newId('t') };
    case 'redact-brush':
      return { ...moved, id: newId('b') };
    default:
      return { ...moved, id: newId('a') };
  }
}
