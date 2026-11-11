/**
 * Is the pointer over something drawn on the canvas?
 *
 * The recognised text sits in the DOM above the canvas so it can be selected with the mouse. While the
 * Select tool has nothing selected those words take every click, which means a shape or note lying over
 * text could not be clicked. The editor does its own hit-testing inside the canvas and does not expose it, so
 * this answers the same question from the document: close enough to an outline, a marker or a filled area.
 * It errs towards "yes" by a few pixels, which only ever hands a click to the canvas.
 */
import type { Annotation } from '@polishot/editor';

export interface Point {
  x: number;
  y: number;
}

export interface HitView {
  /** Source image pixels to CSS pixels in the same space as the pointer. */
  toScreen: (p: Point) => Point;
  /** CSS pixels per source image pixel. */
  scale: number;
}

/** Radius of a numbered step in source pixels; the same rule the canvas draws with. */
export function stepRadius(imageW: number, imageH: number): number {
  return Math.round(Math.min(40, Math.max(11, Math.max(imageW, imageH) * 0.011)));
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const inside = (p: Point, left: number, top: number, right: number, bottom: number): boolean =>
  p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;

function nearOne(a: Annotation, image: { width: number; height: number }, view: HitView, pt: Point, tol: number): boolean {
  const s = view.scale;
  switch (a.type) {
    case 'arrow':
    case 'line': {
      const p1 = view.toScreen({ x: a.points[0], y: a.points[1] });
      const p2 = view.toScreen({ x: a.points[2], y: a.points[3] });
      return distToSegment(pt, p1, p2) <= tol + (a.strokeWidth * s) / 2;
    }
    case 'rect':
    case 'ellipse': {
      const p1 = view.toScreen({ x: a.x, y: a.y });
      const p2 = view.toScreen({ x: a.x + a.w, y: a.y + a.h });
      const left = Math.min(p1.x, p2.x);
      const right = Math.max(p1.x, p2.x);
      const top = Math.min(p1.y, p2.y);
      const bottom = Math.max(p1.y, p2.y);
      const reach = tol + (a.strokeWidth * s) / 2;
      if (a.type === 'rect') {
        if (!inside(pt, left - reach, top - reach, right + reach, bottom + reach)) return false;
        if (a.fill) return true;
        // An outline only: the middle of an empty frame still belongs to the text underneath.
        return !inside(pt, left + reach, top + reach, right - reach, bottom - reach);
      }
      const rx = (right - left) / 2;
      const ry = (bottom - top) / 2;
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const r = Math.max(1, Math.min(rx, ry));
      const d = Math.hypot((pt.x - cx) / Math.max(1, rx), (pt.y - cy) / Math.max(1, ry));
      const slack = reach / r;
      if (d > 1 + slack) return false;
      return a.fill ? true : d >= 1 - slack;
    }
    case 'blur': {
      const p1 = view.toScreen({ x: a.x, y: a.y });
      const p2 = view.toScreen({ x: a.x + a.w, y: a.y + a.h });
      return inside(pt, Math.min(p1.x, p2.x) - tol, Math.min(p1.y, p2.y) - tol, Math.max(p1.x, p2.x) + tol, Math.max(p1.y, p2.y) + tol);
    }
    case 'step': {
      const c = view.toScreen({ x: a.x, y: a.y });
      return Math.hypot(pt.x - c.x, pt.y - c.y) <= stepRadius(image.width, image.height) * s + tol;
    }
    case 'text': {
      const o = view.toScreen({ x: a.x, y: a.y });
      const lines = a.text.split('\n');
      const widest = lines.reduce((m, l) => Math.max(m, l.length), 1);
      const w = widest * a.fontSize * 0.62 * s;
      const h = lines.length * a.fontSize * 1.25 * s;
      return inside(pt, o.x - tol, o.y - tol, o.x + w + tol, o.y + h + tol);
    }
    case 'redact-brush': {
      const reach = tol + (a.size * s) / 2;
      const pts: Point[] = [];
      for (let i = 0; i + 1 < a.points.length; i += 2) pts.push(view.toScreen({ x: a.points[i]!, y: a.points[i + 1]! }));
      if (pts.length === 1) return Math.hypot(pt.x - pts[0]!.x, pt.y - pts[0]!.y) <= reach;
      for (let i = 1; i < pts.length; i++) if (distToSegment(pt, pts[i - 1]!, pts[i]!) <= reach) return true;
      return false;
    }
  }
}

/** True when `pt` is on, or within `tol` pixels of, any annotation. */
export function annotationNear(
  annotations: readonly Annotation[],
  image: { width: number; height: number },
  view: HitView,
  pt: Point,
  tol = 6,
): boolean {
  for (const a of annotations) if (nearOne(a, image, view, pt, tol)) return true;
  return false;
}
