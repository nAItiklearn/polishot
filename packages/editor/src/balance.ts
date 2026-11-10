import {
  contrastRatio,
  deltaE,
  hexToOklch,
  oklabToRgb,
  oklchToHex,
  rgbToHex,
  rgbToOklab,
  type Oklab,
} from './color';
import type { Background, Box, ImageDataLike } from './types';

/* ------------------------------------------------------------------ */
/* Auto-balance: trim near-uniform borders                              */
/* ------------------------------------------------------------------ */

export interface BalanceOptions {
  /** OKLab distance below which a pixel counts as "the same colour" as the border. Default 0.03. */
  tolerance?: number;
  /** Largest share of a dimension that may be trimmed from one side. Default 0.3. */
  maxTrimPerSide?: number;
  /** Trims smaller than this many pixels are ignored (thin window borders are content). Default 2. */
  minTrim?: number;
}

/** Padding fraction used for auto layouts; larger screenshots get proportionally less. */
export function paddingFor(width: number, height: number): number {
  const m = Math.max(width, height);
  const t = Math.min(1, Math.max(0, (m - 600) / 1800));
  return Math.round((0.1 - 0.04 * t) * 1000) / 1000;
}

interface PixelMatcher {
  matches(i: number): boolean;
}

function makeMatcher(d: Uint8ClampedArray, ref: number, tolerance: number): PixelMatcher {
  const rr = d[ref]!;
  const rg = d[ref + 1]!;
  const rb = d[ref + 2]!;
  const ra = d[ref + 3]!;
  const refLab = rgbToOklab(rr, rg, rb);
  // Memoise the last mismatching colour: noisy flat regions repeat the same few values.
  let lastR = -1;
  let lastG = -1;
  let lastB = -1;
  let lastResult = false;
  return {
    matches(i: number): boolean {
      const a = d[i + 3]!;
      if (ra < 8) return a < 8;
      if (Math.abs(a - ra) > 16) return false;
      const r = d[i]!;
      const g = d[i + 1]!;
      const b = d[i + 2]!;
      if (r === rr && g === rg && b === rb) return true;
      if (r === lastR && g === lastG && b === lastB) return lastResult;
      lastR = r;
      lastG = g;
      lastB = b;
      lastResult = deltaE(rgbToOklab(r, g, b), refLab) <= tolerance;
      return lastResult;
    },
  };
}

/**
 * Finds the content box by trimming near-uniform borders from each side. A line is trimmed only when
 * every pixel on it is within `tolerance` (OKLab) of the colour at the outer edge of that side, so real
 * content is never cut; the trim per side is additionally capped. Returns `crop: null` when nothing
 * qualifies. `padding` is the equal padding fraction to apply around the result.
 */
export function autoBalance(
  pixels: ImageDataLike,
  opts: BalanceOptions = {},
): { crop: Box | null; padding: number } {
  const { width: W, height: H, data } = pixels;
  const tolerance = opts.tolerance ?? 0.03;
  const maxTrim = opts.maxTrimPerSide ?? 0.3;
  const minTrim = opts.minTrim ?? 2;
  if (!(W > 2) || !(H > 2) || data.length < W * H * 4) return { crop: null, padding: paddingFor(W || 1, H || 1) };

  const rowUniform = (y: number, x0: number, x1: number, m: PixelMatcher): boolean => {
    let i = (y * W + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) if (!m.matches(i)) return false;
    return true;
  };
  const colUniform = (x: number, y0: number, y1: number, m: PixelMatcher): boolean => {
    let i = (y0 * W + x) * 4;
    const stride = W * 4;
    for (let y = y0; y < y1; y++, i += stride) if (!m.matches(i)) return false;
    return true;
  };

  const capY = Math.floor(H * maxTrim);
  const capX = Math.floor(W * maxTrim);

  // Top and bottom first, using whole rows.
  let top = 0;
  {
    const m = makeMatcher(data, 0, tolerance);
    while (top < capY && rowUniform(top, 0, W, m)) top++;
  }
  let bottom = 0;
  {
    const m = makeMatcher(data, ((H - 1) * W) * 4, tolerance);
    while (bottom < capY && H - 1 - bottom > top && rowUniform(H - 1 - bottom, 0, W, m)) bottom++;
  }
  if (top < minTrim) top = 0;
  if (bottom < minTrim) bottom = 0;

  // Then left and right, restricted to the rows that survived.
  const y0 = top;
  const y1 = H - bottom;
  let left = 0;
  {
    const m = makeMatcher(data, (y0 * W) * 4, tolerance);
    while (left < capX && colUniform(left, y0, y1, m)) left++;
  }
  let right = 0;
  {
    const m = makeMatcher(data, (y0 * W + (W - 1)) * 4, tolerance);
    while (right < capX && W - 1 - right > left && colUniform(W - 1 - right, y0, y1, m)) right++;
  }
  if (left < minTrim) left = 0;
  if (right < minTrim) right = 0;

  const w = W - left - right;
  const h = H - top - bottom;
  const trimmed = top > 0 || bottom > 0 || left > 0 || right > 0;
  const crop: Box | null = trimmed && w >= 1 && h >= 1 ? { x: left, y: top, w, h } : null;
  const cw = crop ? crop.w : W;
  const ch = crop ? crop.h : H;
  return { crop, padding: paddingFor(cw, ch) };
}

/* ------------------------------------------------------------------ */
/* Edge ring sampling + k-means                                         */
/* ------------------------------------------------------------------ */

export interface RingSample {
  /** Flat OKLab triples [L,a,b,...]. */
  lab: Float32Array;
  count: number;
}

/** Samples the outer ring (thickness `ring` px) of `region` (default: the whole image), at most ~`maxPoints` points (1500 is plenty for a handful of colours). */
export function sampleEdgeRing(
  pixels: ImageDataLike,
  region: Box | null = null,
  ring = 4,
  maxPoints = 1500,
): RingSample {
  const { width: W, height: H, data } = pixels;
  const x0 = Math.max(0, Math.floor(region?.x ?? 0));
  const y0 = Math.max(0, Math.floor(region?.y ?? 0));
  const x1 = Math.min(W, Math.ceil((region?.x ?? 0) + (region?.w ?? W)));
  const y1 = Math.min(H, Math.ceil((region?.y ?? 0) + (region?.h ?? H)));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 1 || rh < 1) return { lab: new Float32Array(0), count: 0 };
  const t = Math.max(1, Math.min(ring, Math.floor(Math.min(rw, rh) / 2) || 1));
  const total = 2 * t * (rw + rh) - 4 * t * t;
  const step = Math.max(1, Math.ceil(total / maxPoints));
  const out: number[] = [];
  let n = 0;
  const take = (x: number, y: number) => {
    if (n++ % step !== 0) return;
    const i = (y * W + x) * 4;
    if (data[i + 3]! < 8) return;
    const lab = rgbToOklab(data[i]!, data[i + 1]!, data[i + 2]!);
    out.push(lab.L, lab.a, lab.b);
  };
  for (let y = y0; y < y1; y++) {
    const edgeRow = y < y0 + t || y >= y1 - t;
    if (edgeRow) for (let x = x0; x < x1; x++) take(x, y);
    else {
      for (let x = x0; x < x0 + t; x++) take(x, y);
      for (let x = x1 - t; x < x1; x++) take(x, y);
    }
  }
  return { lab: Float32Array.from(out), count: out.length / 3 };
}

export interface Cluster {
  centroid: Oklab;
  count: number;
}

/** Small deterministic k-means over OKLab points (farthest-first initialisation). Sorted by count, descending. */
export function kmeans(points: Float32Array, k = 4, iterations = 12): Cluster[] {
  const n = Math.floor(points.length / 3);
  if (n === 0) return [];
  k = Math.min(k, n);
  const cent = new Float64Array(k * 3);
  const dist2 = (i: number, c: number) => {
    const dl = points[i * 3]! - cent[c * 3]!;
    const da = points[i * 3 + 1]! - cent[c * 3 + 1]!;
    const db = points[i * 3 + 2]! - cent[c * 3 + 2]!;
    return dl * dl + da * da + db * db;
  };
  cent[0] = points[0]!;
  cent[1] = points[1]!;
  cent[2] = points[2]!;
  const minD = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < n; i++) {
      const d = Math.min(minD[i]!, dist2(i, c - 1));
      minD[i] = d;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    cent[c * 3] = points[best * 3]!;
    cent[c * 3 + 1] = points[best * 3 + 1]!;
    cent[c * 3 + 2] = points[best * 3 + 2]!;
  }
  const assign = new Int32Array(n);
  const counts = new Int32Array(k);
  for (let it = 0; it < iterations; it++) {
    const sums = new Float64Array(k * 3);
    counts.fill(0);
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bc = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(i, c);
        if (d < bd) {
          bd = d;
          bc = c;
        }
      }
      if (assign[i] !== bc) changed = true;
      assign[i] = bc;
      counts[bc] = counts[bc]! + 1;
      sums[bc * 3] = sums[bc * 3]! + points[i * 3]!;
      sums[bc * 3 + 1] = sums[bc * 3 + 1]! + points[i * 3 + 1]!;
      sums[bc * 3 + 2] = sums[bc * 3 + 2]! + points[i * 3 + 2]!;
    }
    for (let c = 0; c < k; c++) {
      const cnt = counts[c]!;
      if (cnt === 0) continue;
      cent[c * 3] = sums[c * 3]! / cnt;
      cent[c * 3 + 1] = sums[c * 3 + 1]! / cnt;
      cent[c * 3 + 2] = sums[c * 3 + 2]! / cnt;
    }
    if (!changed && it > 0) break;
  }
  const clusters: Cluster[] = [];
  for (let c = 0; c < k; c++) {
    if (counts[c]! > 0)
      clusters.push({ centroid: { L: cent[c * 3]!, a: cent[c * 3 + 1]!, b: cent[c * 3 + 2]! }, count: counts[c]! });
  }
  return clusters.sort((p, q) => q.count - p.count);
}

export interface EdgeColor {
  hex: string;
  oklab: Oklab;
  /** Share of the ring samples that belong to the dominant cluster (0..1). */
  share: number;
}

/** Dominant colour of the edge ring of `region` (or the whole image). Null for an empty/transparent ring. */
export function dominantEdgeColor(pixels: ImageDataLike, region: Box | null = null): EdgeColor | null {
  const ring = sampleEdgeRing(pixels, region);
  if (ring.count === 0) return null;
  const clusters = kmeans(ring.lab, 4);
  const top = clusters[0];
  if (!top) return null;
  const [r, g, b] = oklabToRgb(top.centroid.L, top.centroid.a, top.centroid.b);
  return { hex: rgbToHex(r, g, b), oklab: top.centroid, share: top.count / ring.count };
}

/* ------------------------------------------------------------------ */
/* Tasteful gradient from an edge colour                                */
/* ------------------------------------------------------------------ */

export const MIN_BACKGROUND_CONTRAST = 3;
/** Fallback used when there is no edge colour (warm stone). */
export const NEUTRAL_STOPS: [string, string] = ['#8a8279', '#5f5952'];
export const AUTO_ANGLE = 155;

/**
 * Derives a two-stop gradient from the edge colour that keeps the hue family of the edge (or warm stone
 * for neutral edges) and at least 3:1 WCAG contrast against the edge colour itself, so the content never
 * melts into its backdrop.
 */
export function deriveGradient(edgeHex: string): [string, string] {
  const edge = hexToOklch(edgeHex);
  if (!edge) return NEUTRAL_STOPS;
  const neutral = edge.C < 0.03;
  const hue = neutral ? 70 : edge.h;
  const chroma = neutral ? 0.022 : Math.min(0.085, Math.max(0.035, edge.C * 0.5));
  const darkFirst = edge.L > 0.56;

  const build = (dark: boolean): [string, string] | null => {
    const tones = dark ? [0.47, 0.35] : [0.9, 0.82];
    const hues = [hue, hue + (neutral ? -8 : 14)];
    const out: string[] = [];
    for (let i = 0; i < 2; i++) {
      let L = tones[i]!;
      let hex = oklchToHex(L, chroma * (dark ? 1 : 0.7), hues[i]!);
      for (let step = 0; step < 40 && contrastRatio(hex, edgeHex) < MIN_BACKGROUND_CONTRAST + 0.15; step++) {
        L += dark ? -0.02 : 0.02;
        if (L < 0.04 || L > 0.985) return null;
        hex = oklchToHex(L, chroma * (dark ? 1 : 0.7), hues[i]!);
      }
      if (contrastRatio(hex, edgeHex) < MIN_BACKGROUND_CONTRAST) return null;
      out.push(hex);
    }
    return [out[0]!, out[1]!];
  };

  return build(darkFirst) ?? build(!darkFirst) ?? NEUTRAL_STOPS;
}

/** Resolves the background to use for the auto mode: dominant edge colour of the content -> gradient. */
export function autoBackground(pixels: ImageDataLike, region: Box | null = null): Background {
  const edge = dominantEdgeColor(pixels, region);
  if (!edge) return { type: 'auto', stops: NEUTRAL_STOPS };
  return { type: 'auto', color: edge.hex, stops: deriveGradient(edge.hex) };
}
