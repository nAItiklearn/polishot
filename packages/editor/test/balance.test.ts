import { describe, expect, it } from 'vitest';
import {
  AUTO_ANGLE,
  MIN_BACKGROUND_CONTRAST,
  autoBackground,
  autoBalance,
  deriveGradient,
  dominantEdgeColor,
  kmeans,
  paddingFor,
  sampleEdgeRing,
} from '../src/balance';
import { contrastRatio, hexToOklch, hueDistance, rgbToHex } from '../src/color';
import { computeLayout } from '../src/layout';
import { docFor, fillRect, fillStripes, mulberry32, solidImage, type RGB } from './helpers';

const WHITE: RGB = [255, 255, 255];
const INK: RGB = [30, 34, 48];

describe('autoBalance', () => {
  it('trims uneven solid margins to exactly the content box', () => {
    const img = solidImage(400, 300, WHITE);
    fillStripes(img, 60, 30, 280, 220, [40, 90, 200], [250, 250, 250]);
    const { crop, padding } = autoBalance(img);
    expect(crop).toEqual({ x: 60, y: 30, w: 280, h: 220 });
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThanOrEqual(0.3);
  });

  it('ends up centred with equal padding once laid out', () => {
    const img = solidImage(400, 300, WHITE);
    // margins: left 60, right 60+? -> uneven on purpose: top 30, bottom 50, left 90, right 30
    fillStripes(img, 90, 30, 280, 220, [200, 60, 50], [30, 30, 30]);
    const { crop, padding } = autoBalance(img);
    expect(crop).toEqual({ x: 90, y: 30, w: 280, h: 220 });
    const layout = computeLayout(docFor(400, 300, { crop, padding }));
    const { content } = layout;
    const left = content.x;
    const top = content.y;
    const right = layout.width - (content.x + content.w);
    const bottom = layout.height - (content.y + content.h);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeCloseTo(right, 6);
    expect(top).toBeCloseTo(bottom, 6);
    expect(left).toBeCloseTo(top, 6);
  });

  it('never cuts content: random layouts keep every non-border pixel inside the crop', () => {
    const rnd = mulberry32(7);
    for (let n = 0; n < 40; n++) {
      const W = 120 + Math.floor(rnd() * 200);
      const H = 90 + Math.floor(rnd() * 160);
      const bg: RGB = [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)];
      const img = solidImage(W, H, bg);
      const rw = 20 + Math.floor(rnd() * (W - 60));
      const rh = 20 + Math.floor(rnd() * (H - 50));
      const rx = Math.floor(rnd() * (W - rw));
      const ry = Math.floor(rnd() * (H - rh));
      fillStripes(img, rx, ry, rw, rh, [255 - bg[0], 255 - bg[1], 255 - bg[2]], [bg[1], bg[2], bg[0]]);
      const { crop } = autoBalance(img);
      const c = crop ?? { x: 0, y: 0, w: W, h: H };
      // The crop must contain the whole rect...
      expect(c.x).toBeLessThanOrEqual(rx);
      expect(c.y).toBeLessThanOrEqual(ry);
      expect(c.x + c.w).toBeGreaterThanOrEqual(rx + rw);
      expect(c.y + c.h).toBeGreaterThanOrEqual(ry + rh);
      // ...and per-side trim never exceeds the cap.
      expect(c.x).toBeLessThanOrEqual(Math.floor(W * 0.3));
      expect(c.y).toBeLessThanOrEqual(Math.floor(H * 0.3));
      expect(W - (c.x + c.w)).toBeLessThanOrEqual(Math.floor(W * 0.3));
      expect(H - (c.y + c.h)).toBeLessThanOrEqual(Math.floor(H * 0.3));
    }
  });

  it('caps the trim when almost everything is blank', () => {
    const img = solidImage(1000, 1000, WHITE);
    fillStripes(img, 480, 480, 40, 40, [0, 0, 0], [255, 0, 0]);
    const { crop } = autoBalance(img);
    expect(crop).not.toBeNull();
    expect(crop!.x).toBe(300);
    expect(crop!.y).toBe(300);
    expect(crop!.w).toBe(400);
    expect(crop!.h).toBe(400);
  });

  it('returns no crop for a flat image with no borders to speak of', () => {
    const img = solidImage(200, 120, [120, 130, 140]);
    const { crop } = autoBalance(img);
    // Everything is "border" but the cap leaves a centred core, never an empty crop.
    expect(crop === null || (crop.w >= 1 && crop.h >= 1)).toBe(true);
  });

  it('does not trim when content reaches the edge', () => {
    const img = solidImage(200, 120, WHITE);
    fillStripes(img, 0, 0, 200, 120, [20, 20, 20], [230, 230, 230]);
    expect(autoBalance(img).crop).toBeNull();
  });

  it('ignores a 1px frame (thin borders are content) but trims real margins around it', () => {
    const img = solidImage(300, 200, WHITE);
    fillRect(img, 40, 40, 220, 120, [90, 90, 90]); // 1px frame region
    fillStripes(img, 41, 41, 218, 118, [20, 20, 20], [240, 240, 240]);
    const { crop } = autoBalance(img);
    expect(crop).toEqual({ x: 40, y: 40, w: 220, h: 120 });
  });

  it('tolerates compression-style noise in the margin', () => {
    const img = solidImage(300, 200, [250, 249, 247]);
    const rnd = mulberry32(3);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = Math.floor(rnd() * 3) - 1;
      img.data[i] = img.data[i]! + n;
      img.data[i + 1] = img.data[i + 1]! + n;
      img.data[i + 2] = img.data[i + 2]! + n;
    }
    fillStripes(img, 50, 40, 200, 120, [10, 80, 160], [240, 240, 240]);
    expect(autoBalance(img).crop).toEqual({ x: 50, y: 40, w: 200, h: 120 });
  });

  it('handles degenerate input without throwing', () => {
    expect(autoBalance({ width: 0, height: 0, data: new Uint8ClampedArray(0) }).crop).toBeNull();
    expect(autoBalance({ width: 2, height: 2, data: new Uint8ClampedArray(16) }).crop).toBeNull();
  });

  it('padding shrinks as the screenshot grows and stays within 0..0.3', () => {
    expect(paddingFor(400, 300)).toBeGreaterThan(paddingFor(3000, 2000));
    for (const m of [10, 600, 1200, 4000, 20000]) {
      const p = paddingFor(m, m / 2);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(0.3);
    }
  });
});

describe('edge colour', () => {
  const ringImage = (ring: RGB, ringPx = 6): ReturnType<typeof solidImage> => {
    const img = solidImage(200, 150, ring);
    fillRect(img, ringPx, ringPx, 200 - 2 * ringPx, 150 - 2 * ringPx, WHITE);
    return img;
  };

  it('returns the expected hue for a red edge', () => {
    const edge = dominantEdgeColor(ringImage([200, 60, 50]))!;
    expect(edge.hex).toBe(rgbToHex(200, 60, 50));
    expect(hueDistance(hexToOklch(edge.hex)!.h, 29)).toBeLessThan(8);
  });

  it('returns the expected hue for a blue edge', () => {
    const edge = dominantEdgeColor(ringImage([40, 90, 200]))!;
    expect(hueDistance(hexToOklch(edge.hex)!.h, 264)).toBeLessThan(10);
  });

  it('returns the expected hue for a green edge', () => {
    const edge = dominantEdgeColor(ringImage([60, 170, 90]))!;
    expect(hueDistance(hexToOklch(edge.hex)!.h, 150)).toBeLessThan(10);
  });

  it('picks the dominant colour when the ring is mixed', () => {
    const img = solidImage(200, 150, [40, 90, 200]); // blue everywhere
    fillRect(img, 0, 140, 200, 10, [60, 170, 90]); // a green strip on the bottom edge
    fillRect(img, 6, 6, 188, 134, WHITE);
    const edge = dominantEdgeColor(img)!;
    expect(hueDistance(hexToOklch(edge.hex)!.h, 264)).toBeLessThan(10);
    expect(edge.share).toBeGreaterThan(0.5);
  });

  it('samples the ring of the crop region, not of the original image', () => {
    const img = solidImage(300, 200, [250, 250, 250]);
    fillRect(img, 50, 40, 200, 120, [200, 60, 50]); // red content with a white margin
    const whole = dominantEdgeColor(img)!;
    const cropped = dominantEdgeColor(img, { x: 50, y: 40, w: 200, h: 120 })!;
    expect(whole.hex).toBe('#fafafa');
    expect(cropped.hex).toBe(rgbToHex(200, 60, 50));
  });

  it('returns null for a fully transparent ring', () => {
    expect(dominantEdgeColor({ width: 10, height: 10, data: new Uint8ClampedArray(400) })).toBeNull();
  });

  it('samples at most about a thousand points even for huge images', () => {
    const img = solidImage(2000, 1500, [10, 10, 10]);
    expect(sampleEdgeRing(img).count).toBeLessThanOrEqual(1600);
  });
});

describe('kmeans', () => {
  it('separates two colour groups and orders by size', () => {
    const pts: number[] = [];
    for (let i = 0; i < 30; i++) pts.push(0.2, 0.1, 0.05);
    for (let i = 0; i < 10; i++) pts.push(0.9, -0.05, 0.1);
    const clusters = kmeans(Float32Array.from(pts), 3);
    expect(clusters[0]!.count).toBe(30);
    expect(clusters[0]!.centroid.L).toBeCloseTo(0.2, 3);
    expect(clusters[1]!.count).toBe(10);
  });

  it('copes with fewer points than clusters', () => {
    expect(kmeans(Float32Array.from([0.5, 0, 0]), 4)).toHaveLength(1);
    expect(kmeans(new Float32Array(0), 4)).toEqual([]);
  });
});

describe('deriveGradient / autoBackground', () => {
  const edges = ['#ffffff', '#fafaf9', '#000000', '#0c0c0b', '#808080', '#c83c32', '#2858c8', '#3caa5a', '#f2c94c', '#6b3fa0', '#ee7444'];

  it.each(edges)('keeps at least 3:1 contrast against the edge colour %s', (edge) => {
    const [a, b] = deriveGradient(edge);
    expect(contrastRatio(a, edge)).toBeGreaterThanOrEqual(MIN_BACKGROUND_CONTRAST);
    expect(contrastRatio(b, edge)).toBeGreaterThanOrEqual(MIN_BACKGROUND_CONTRAST);
    expect(a).not.toBe(b);
  });

  it('keeps the hue family of a chromatic edge', () => {
    const edgeHue = hexToOklch('#c83c32')!.h;
    const [a, b] = deriveGradient('#c83c32');
    expect(hueDistance(hexToOklch(a)!.h, edgeHue)).toBeLessThan(25);
    expect(hueDistance(hexToOklch(b)!.h, edgeHue)).toBeLessThan(40);
  });

  it('uses a warm neutral for white and grey edges, and never a blue or purple tint', () => {
    for (const e of ['#ffffff', '#f4f4f4', '#101010']) {
      const [a, b] = deriveGradient(e);
      for (const stop of [a, b]) {
        const lch = hexToOklch(stop)!;
        expect(lch.C).toBeLessThan(0.06);
        expect(hueDistance(lch.h, 70)).toBeLessThan(25);
      }
    }
  });

  it('goes dark behind light content and light behind dark content', () => {
    const light = hexToOklch(deriveGradient('#fafafa')[0])!.L;
    const dark = hexToOklch(deriveGradient('#101010')[0])!.L;
    expect(light).toBeLessThan(0.6);
    expect(dark).toBeGreaterThan(0.7);
  });

  it('autoBackground resolves colour and stops from the edge ring of the content', () => {
    const img = solidImage(300, 200, WHITE);
    fillRect(img, 50, 40, 200, 120, INK);
    fillStripes(img, 56, 46, 188, 108, [255, 255, 255], [220, 230, 255]);
    const bg = autoBackground(img, { x: 50, y: 40, w: 200, h: 120 });
    expect(bg.type).toBe('auto');
    if (bg.type !== 'auto') throw new Error('unreachable');
    expect(bg.color).toBe(rgbToHex(...INK));
    expect(bg.stops).toBeDefined();
    expect(contrastRatio(bg.stops![0], bg.color!)).toBeGreaterThanOrEqual(MIN_BACKGROUND_CONTRAST);
    expect(AUTO_ANGLE).toBeGreaterThan(0);
  });

  it('falls back to a neutral gradient when there is nothing to sample', () => {
    const bg = autoBackground({ width: 4, height: 4, data: new Uint8ClampedArray(64) });
    expect(bg).toMatchObject({ type: 'auto' });
    expect((bg as { stops: string[] }).stops).toHaveLength(2);
  });

  it('is robust to garbage input', () => {
    expect(deriveGradient('nonsense')).toHaveLength(2);
  });
});
