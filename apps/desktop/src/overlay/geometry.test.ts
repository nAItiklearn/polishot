import { describe, expect, it } from 'vitest';
import type { WindowInfo } from '../ipc';
import {
  cssRectToPhysical,
  hitTestWindow,
  loupeSample,
  normalizeRect,
  placeNear,
  snapToDevicePixel,
  windowRectToCss,
} from './geometry';

describe('normalizeRect', () => {
  it('handles drags in every direction', () => {
    expect(normalizeRect({ x: 10, y: 20 }, { x: 40, y: 80 })).toEqual({ x: 10, y: 20, w: 30, h: 60 });
    expect(normalizeRect({ x: 40, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 30, h: 60 });
    expect(normalizeRect({ x: 40, y: 20 }, { x: 10, y: 80 })).toEqual({ x: 10, y: 20, w: 30, h: 60 });
  });
});

describe('cssRectToPhysical', () => {
  it('rounds edges, not sizes, at fractional scales', () => {
    // 125% scale: left 10.4 -> 13, right 30.4 -> 38, bottom 10 -> 12.5 -> 13
    const r = cssRectToPhysical({ x: 10.4, y: 0, w: 20, h: 10 }, 1.25, 1000, 1000);
    expect(r).toEqual({ x: 13, y: 0, w: 25, h: 13 });
  });
  it('clamps to the frame', () => {
    const r = cssRectToPhysical({ x: -10, y: -10, w: 5000, h: 5000 }, 2, 1920, 1080);
    expect(r).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
  it('never yields negative sizes', () => {
    const r = cssRectToPhysical({ x: 2000, y: 0, w: 10, h: 10 }, 1, 1920, 1080);
    expect(r.w).toBe(0);
  });
});

describe('snapToDevicePixel', () => {
  it('lands on device pixel boundaries', () => {
    expect(snapToDevicePixel(10.3, 2)).toBe(10.5);
    expect(snapToDevicePixel(10.2, 2)).toBe(10);
    expect(snapToDevicePixel(7.6, 1)).toBe(8);
  });
});

describe('window hit testing with negative virtual-desktop coordinates', () => {
  const bounds = { x: -1920, y: 0, w: 1920, h: 1080 };
  const win = (hwnd: number, x: number, y: number, w: number, h: number): WindowInfo => ({
    hwnd,
    title: `w${hwnd}`,
    app: 'app',
    rect: { x, y, w, h },
    monitor: 0,
  });
  const windows = [win(1, -1500, 100, 600, 400), win(2, -1920, 0, 1920, 1080)];

  it('prefers the front-most window', () => {
    const hit = hitTestWindow(windows, bounds, 1, { x: 500, y: 200 });
    expect(hit?.hwnd).toBe(1);
  });
  it('falls through to windows behind', () => {
    const hit = hitTestWindow(windows, bounds, 1, { x: 1800, y: 900 });
    expect(hit?.hwnd).toBe(2);
  });
  it('accounts for scale', () => {
    const b = { x: -3000, y: 0, w: 3000, h: 2000 };
    const w = [win(7, -2000, 400, 1200, 600)];
    // css (1000, 300) at scale 2 -> global (-1000, 600): inside
    expect(hitTestWindow(w, b, 2, { x: 1000, y: 300 })?.hwnd).toBe(7);
    // css (100, 300) -> global (-2800, 600): outside
    expect(hitTestWindow(w, b, 2, { x: 100, y: 300 })).toBeNull();
  });
});

describe('windowRectToCss', () => {
  it('clips to the monitor and converts to css px', () => {
    const bounds = { x: 0, y: 0, w: 2560, h: 1440 };
    const r = windowRectToCss({ x: -100, y: 100, w: 1100, h: 5000 }, bounds, 2);
    expect(r).toEqual({ x: 0, y: 50, w: 500, h: 670 });
  });
});

describe('loupeSample', () => {
  it('centres on the cursor pixel', () => {
    const s = loupeSample({ x: 100, y: 100 }, 16, 128, 1920, 1080);
    expect(s).toEqual({ sx: 92, sy: 92, sw: 16, sh: 16, dx: 0, dy: 0, dw: 128, dh: 128 });
  });
  it('leaves out-of-frame cells empty instead of stretching', () => {
    const s = loupeSample({ x: 2, y: 2 }, 16, 128, 1920, 1080);
    expect(s).toEqual({ sx: 0, sy: 0, sw: 10, sh: 10, dx: 48, dy: 48, dw: 80, dh: 80 });
  });
  it('returns null when fully outside', () => {
    expect(loupeSample({ x: -100, y: -100 }, 16, 128, 1920, 1080)).toBeNull();
  });
});

describe('placeNear', () => {
  const vp = { w: 1000, h: 800 };
  const size = { w: 100, h: 100 };
  it('sits bottom-right of the cursor by default', () => {
    expect(placeNear({ x: 10, y: 10 }, size, vp, 20)).toEqual({ x: 30, y: 30 });
  });
  it('flips at the right and bottom edges', () => {
    expect(placeNear({ x: 990, y: 790 }, size, vp, 20)).toEqual({ x: 870, y: 670 });
  });
});
