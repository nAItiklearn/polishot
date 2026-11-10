import { isSafeImageSrc } from './doc';
import { watermarkLayout } from './watermark';

/**
 * Pro feature (CONTRACTS section 5b): the user's own logo or text instead of the default watermark.
 * It is an app-level setting, not part of the document, so it never enters undo history or saved docs.
 */
export type BrandMark = { type: 'text'; text: string } | { type: 'image'; src: string };

/** Longest brand text, in characters. It is a quiet signature, not a caption. */
export const BRAND_MARK_MAX_TEXT = 40;

/**
 * Control characters plus the bidirectional overrides (U+202A to U+202E) and isolates (U+2066 to U+2069):
 * harmless for a signature, but a classic spoofing tool.
 */
const UNWANTED = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Validates untrusted input and returns a fresh, minimal brand mark, or null.
 * Text is whitespace-normalised, stripped of control characters and cut to `BRAND_MARK_MAX_TEXT`.
 * An image must pass `isSafeImageSrc` (inline raster `data:`, `blob:`, or a listed origin); SVG, `file:`,
 * `javascript:` and unlisted remote hosts are refused.
 */
export function sanitizeBrandMark(input: unknown, origins?: readonly string[]): BrandMark | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const proto = Object.getPrototypeOf(input) as unknown;
  if (proto !== Object.prototype && proto !== null) return null;
  const rec = input as Record<string, unknown>;
  const type = Object.hasOwn(rec, 'type') ? rec.type : undefined;
  if (type === 'text') {
    const raw = Object.hasOwn(rec, 'text') ? rec.text : undefined;
    if (typeof raw !== 'string') return null;
    const text = [...raw.replace(UNWANTED, ' ').replace(/\s+/g, ' ').trim()]
      .slice(0, BRAND_MARK_MAX_TEXT)
      .join('')
      .trim();
    return text ? { type: 'text', text } : null;
  }
  if (type === 'image') {
    const src = Object.hasOwn(rec, 'src') ? rec.src : undefined;
    return typeof src === 'string' && isSafeImageSrc(src, origins) ? { type: 'image', src } : null;
  }
  return null;
}

/** What the corner mark is. `default` is our watermark, `none` is a clean Pro export. */
export type MarkPlan =
  | { kind: 'default' }
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string }
  | { kind: 'none' };

/**
 * The single decision point for exports and the canvas. Fails closed: unless `licensed` is exactly `true`
 * the default watermark is drawn and any brand mark is ignored, however it was set. A licensed export with
 * no (valid) brand mark is clean.
 */
export function markPlan(licensed: unknown, mark: unknown, origins?: readonly string[]): MarkPlan {
  if (licensed !== true) return { kind: 'default' };
  const clean = sanitizeBrandMark(mark, origins);
  if (!clean) return { kind: 'none' };
  return clean.type === 'text' ? { kind: 'text', text: clean.text } : { kind: 'image', src: clean.src };
}

export interface MarkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Widest a text mark may be, so a long signature never runs across the picture. */
export function brandTextMaxWidth(canvasW: number): number {
  return Math.max(40, Math.round(canvasW * 0.5));
}

/**
 * Where a logo goes: bottom-right at the same margin as the text watermark, scaled to contain within a box
 * about two lines tall (the same visual weight as the text watermark). Null when the logo has no size.
 */
export function brandImageBox(canvasW: number, canvasH: number, naturalW: number, naturalH: number): MarkBox | null {
  if (!(naturalW > 0) || !(naturalH > 0) || !(canvasW > 0) || !(canvasH > 0)) return null;
  const { fontSize, margin } = watermarkLayout(canvasW, canvasH);
  const maxH = fontSize * 2.2;
  const maxW = Math.min(fontSize * 9, canvasW * 0.4);
  const k = Math.min(maxW / naturalW, maxH / naturalH);
  const w = Math.max(1, naturalW * k);
  const h = Math.max(1, naturalH * k);
  return {
    x: Math.max(0, canvasW - margin - w),
    y: Math.max(0, canvasH - margin - h),
    w,
    h,
  };
}
