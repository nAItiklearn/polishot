/**
 * Pure geometry helpers for the capture overlay.
 *
 * Coordinate spaces:
 *  - "css":      CSS pixels, origin at the top-left of this overlay window (one per monitor).
 *  - "physical": device pixels of the monitor, origin at the monitor's top-left. This is also the
 *                pixel grid of the frozen frame, so loupe/crop maths happens here.
 *  - "global":   physical pixels in the virtual desktop (may be negative on secondary monitors).
 */
import type { Box, WindowInfo } from '../ipc';

export interface Point {
  x: number;
  y: number;
}

/** Rectangle from two drag corners, independent of drag direction. */
export function normalizeRect(a: Point, b: Point): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function clampPoint(p: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(p.x, 0), width),
    y: Math.min(Math.max(p.y, 0), height),
  };
}

/**
 * CSS rect to an integer physical rect. Edges are rounded (not the size) so adjacent selections
 * never drift by a pixel at fractional scales such as 125% or 175%.
 */
export function cssRectToPhysical(r: Box, scale: number, maxW: number, maxH: number): Box {
  const left = clampInt(Math.round(r.x * scale), 0, maxW);
  const top = clampInt(Math.round(r.y * scale), 0, maxH);
  const right = clampInt(Math.round((r.x + r.w) * scale), 0, maxW);
  const bottom = clampInt(Math.round((r.y + r.h) * scale), 0, maxH);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

/** Snap a CSS coordinate to the nearest device pixel so 1px lines stay crisp. */
export function snapToDevicePixel(v: number, scale: number): number {
  return Math.round(v * scale) / scale;
}

/** Window rect (global physical) to CSS rect relative to this monitor, clipped to it. */
export function windowRectToCss(win: Box, bounds: Box, scale: number): Box {
  const left = Math.max(win.x, bounds.x);
  const top = Math.max(win.y, bounds.y);
  const right = Math.min(win.x + win.w, bounds.x + bounds.w);
  const bottom = Math.min(win.y + win.h, bounds.y + bounds.h);
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  return { x: (left - bounds.x) / scale, y: (top - bounds.y) / scale, w: w / scale, h: h / scale };
}

/** Topmost window containing the cursor. `windows` is in z-order, front first. */
export function hitTestWindow(
  windows: readonly WindowInfo[],
  bounds: Box,
  scale: number,
  cursor: Point,
): WindowInfo | null {
  const gx = bounds.x + cursor.x * scale;
  const gy = bounds.y + cursor.y * scale;
  for (const w of windows) {
    const r = w.rect;
    if (gx >= r.x && gx < r.x + r.w && gy >= r.y && gy < r.y + r.h) return w;
  }
  return null;
}

export interface LoupeSample {
  /** Source rect in physical frame pixels (already clipped to the frame). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination rect in loupe canvas pixels. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Source/destination rects for a `grid x grid` physical-pixel loupe centred on `center`
 * (physical frame coordinates). Out-of-frame cells are left empty, not stretched.
 */
export function loupeSample(
  center: Point,
  grid: number,
  canvasSize: number,
  frameW: number,
  frameH: number,
): LoupeSample | null {
  const half = Math.floor(grid / 2);
  const x0 = Math.floor(center.x) - half;
  const y0 = Math.floor(center.y) - half;
  const sx = Math.max(0, x0);
  const sy = Math.max(0, y0);
  const ex = Math.min(frameW, x0 + grid);
  const ey = Math.min(frameH, y0 + grid);
  if (ex <= sx || ey <= sy) return null;
  const cell = canvasSize / grid;
  return {
    sx,
    sy,
    sw: ex - sx,
    sh: ey - sy,
    dx: (sx - x0) * cell,
    dy: (sy - y0) * cell,
    dw: (ex - sx) * cell,
    dh: (ey - sy) * cell,
  };
}

/** Place a floating box near the cursor, flipping to the other side when it would overflow. */
export function placeNear(
  cursor: Point,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  offset: number,
): Point {
  let x = cursor.x + offset;
  let y = cursor.y + offset;
  if (x + size.w > viewport.w) x = cursor.x - offset - size.w;
  if (y + size.h > viewport.h) y = cursor.y - offset - size.h;
  return {
    x: Math.min(Math.max(x, 0), Math.max(0, viewport.w - size.w)),
    y: Math.min(Math.max(y, 0), Math.max(0, viewport.h - size.h)),
  };
}

export function formatSize(w: number, h: number): string {
  return `${w} × ${h}`;
}

/** Selections smaller than this (CSS px) are treated as a click, not a drag. */
export const MIN_DRAG_PX = 4;

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
