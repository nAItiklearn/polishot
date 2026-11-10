/**
 * Colour math: sRGB <-> OKLab/OKLCH, WCAG contrast, tolerant CSS colour parsing.
 * Pure functions, no DOM.
 */

export interface Oklab {
  L: number;
  a: number;
  b: number;
}
export interface Oklch {
  L: number;
  C: number;
  /** Degrees, 0..360. */
  h: number;
}

const LIN_LUT = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

export function srgbToLinear(v255: number): number {
  const i = Math.round(v255);
  if (i >= 0 && i <= 255 && i === v255) return LIN_LUT[i]!;
  const c = Math.min(1, Math.max(0, v255 / 255));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
}

/** r,g,b in 0..255. */
export function rgbToOklab(r: number, g: number, b: number): Oklab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Linear-light RGB (unclamped, may leave 0..1 when out of gamut). */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const EPS = 1e-4;
const inGamut = (rgb: [number, number, number]) => rgb.every((c) => c >= -EPS && c <= 1 + EPS);

/** OKLab -> sRGB 0..255, clamped (no chroma reduction). */
export function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const lin = oklabToLinear(L, a, b);
  return lin.map((c) => Math.min(255, Math.max(0, Math.round(linearToSrgb(Math.min(1, Math.max(0, c))))))) as [
    number,
    number,
    number,
  ];
}

export function oklabToOklch({ L, a, b }: Oklab): Oklch {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h: C < 1e-4 ? 0 : h };
}

export function oklchToOklab({ L, C, h }: Oklch): Oklab {
  const r = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(r), b: C * Math.sin(r) };
}

/** OKLCH -> sRGB 0..255, reducing chroma (keeping L and h) until the colour is inside the sRGB gamut. */
export function oklchToRgb(L: number, C: number, h: number): [number, number, number] {
  const Lc = Math.min(1, Math.max(0, L));
  let lab = oklchToOklab({ L: Lc, C: Math.max(0, C), h });
  if (!inGamut(oklabToLinear(lab.L, lab.a, lab.b))) {
    let lo = 0;
    let hi = Math.max(0, C);
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      lab = oklchToOklab({ L: Lc, C: mid, h });
      if (inGamut(oklabToLinear(lab.L, lab.a, lab.b))) lo = mid;
      else hi = mid;
    }
    lab = oklchToOklab({ L: Lc, C: lo, h });
  }
  return oklabToRgb(lab.L, lab.a, lab.b);
}

const hex2 = (n: number) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function oklchToHex(L: number, C: number, h: number): string {
  const [r, g, b] = oklchToRgb(L, C, h);
  return rgbToHex(r, g, b);
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FN_RE = /^(rgb|rgba)\(\s*(\d{1,3}(?:\.\d+)?)\s*[, ]\s*(\d{1,3}(?:\.\d+)?)\s*[, ]\s*(\d{1,3}(?:\.\d+)?)\s*(?:[,/]\s*(\d(?:\.\d+)?|\.\d+|\d{1,3}%)\s*)?\)$/i;

/**
 * Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(). Returns [r,g,b,a] with r,g,b in 0..255 and a in 0..1,
 * or null for anything else. Deliberately strict: colours come from untrusted documents.
 */
export function parseColor(input: string): [number, number, number, number] | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.trim();
  if (HEX_RE.test(s)) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const m = FN_RE.exec(s);
  if (m) {
    const ch = (v: string) => Math.min(255, Number(v));
    let a = 1;
    if (m[5] !== undefined) a = m[5].endsWith('%') ? Number.parseFloat(m[5]) / 100 : Number(m[5]);
    if (!Number.isFinite(a)) return null;
    return [ch(m[2]!), ch(m[3]!), ch(m[4]!), Math.min(1, Math.max(0, a))];
  }
  return null;
}

export function isSafeColor(input: unknown): input is string {
  return typeof input === 'string' && parseColor(input) !== null;
}

export function hexToOklab(hex: string): Oklab | null {
  const p = parseColor(hex);
  return p ? rgbToOklab(p[0], p[1], p[2]) : null;
}

export function hexToOklch(hex: string): Oklch | null {
  const lab = hexToOklab(hex);
  return lab ? oklabToOklch(lab) : null;
}

/** WCAG relative luminance, 0..1. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio between two colours, 1..21. Unparseable colours yield 1. */
export function contrastRatio(a: string, b: string): number {
  const pa = parseColor(a);
  const pb = parseColor(b);
  if (!pa || !pb) return 1;
  const la = relativeLuminance(pa[0], pa[1], pa[2]);
  const lb = relativeLuminance(pb[0], pb[1], pb[2]);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean distance in OKLab (0 = identical; ~0.02 is a just-noticeable difference). */
export function deltaE(p: Oklab, q: Oklab): number {
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

/** Smallest angle between two hues in degrees (0..180). */
export function hueDistance(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

/** Picks black or white text for readability on the given background. */
export function readableOn(bg: string): '#000000' | '#ffffff' {
  const p = parseColor(bg);
  if (!p) return '#ffffff';
  const l = relativeLuminance(p[0], p[1], p[2]);
  return l > 0.34 ? '#000000' : '#ffffff';
}
