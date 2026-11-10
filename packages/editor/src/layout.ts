import { frameSpec } from './frames';
import { CUSTOM_MAX, CUSTOM_MIN, PRESETS } from './presets';
import type { Box, EditorDoc, Layout } from './types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Source rectangle that is shown: the crop, or the whole image. */
export function contentBox(doc: Pick<EditorDoc, 'crop' | 'image'>): Box {
  return doc.crop ?? { x: 0, y: 0, w: doc.image.width, h: doc.image.height };
}

/** Fixed canvas size for the doc's preset, or null for the auto layout. */
export function presetSize(doc: Pick<EditorDoc, 'preset' | 'custom'>): { width: number; height: number } | null {
  if (doc.preset === 'custom') {
    if (!doc.custom) return null;
    return {
      width: Math.round(clamp(doc.custom.width, CUSTOM_MIN, CUSTOM_MAX)),
      height: Math.round(clamp(doc.custom.height, CUSTOM_MIN, CUSTOM_MAX)),
    };
  }
  const p = PRESETS[doc.preset];
  return p.width && p.height ? { width: p.width, height: p.height } : null;
}

/**
 * Computes the output canvas and where the content lands.
 *
 * Padding is `doc.padding * max(framed w, framed h)` measured on the displayed content, so the same value
 * looks the same for auto and fixed-size presets. Fixed presets scale the framed content to fit and centre it.
 * Auto layouts keep scale 1 and snap the padding to whole pixels so the image stays crisp.
 */
export function computeLayout(doc: EditorDoc): Layout {
  const box = contentBox(doc);
  const cw = Math.max(1, box.w);
  const ch = Math.max(1, box.h);
  const spec = frameSpec(doc.frame, cw, ch);
  const fw = cw + spec.insets.l + spec.insets.r;
  const fh = ch + spec.insets.t + spec.insets.b;
  const m = Math.max(fw, fh);
  const p = clamp(Number.isFinite(doc.padding) ? doc.padding : 0, 0, 0.3);
  const target = presetSize(doc);

  let width: number;
  let height: number;
  let scale: number;
  let pad: number;
  if (!target) {
    scale = 1;
    pad = Math.round(p * m);
    width = Math.round(fw + 2 * pad);
    height = Math.round(fh + 2 * pad);
  } else {
    width = target.width;
    height = target.height;
    scale = Math.min(width / (fw + 2 * p * m), height / (fh + 2 * p * m));
    pad = p * m * scale;
  }
  const frameW = fw * scale;
  const frameH = fh * scale;
  const fx = (width - frameW) / 2;
  const fy = (height - frameH) / 2;
  return {
    width,
    height,
    content: {
      x: fx + spec.insets.l * scale,
      y: fy + spec.insets.t * scale,
      w: cw * scale,
      h: ch * scale,
      scale,
    },
    frame: { x: fx, y: fy, w: frameW, h: frameH },
    pad,
  };
}

export const MAX_EXPORT_SIDE = 16384;
export const MAX_EXPORT_PIXELS = 120_000_000;

export interface ExportSize {
  width: number;
  height: number;
  /** The pixel ratio that will really be used (lower than requested, even below 1, for canvases beyond browser limits). */
  pixelRatio: number;
  clamped: boolean;
}

/** Output size in pixels for an export at `scale`, reduced if the canvas would exceed browser limits. */
export function computeExportSize(doc: EditorDoc, scale: number): ExportSize {
  const { width, height } = computeLayout(doc);
  let ratio = Math.max(1, scale);
  const limit = Math.min(MAX_EXPORT_SIDE / Math.max(width, height), Math.sqrt(MAX_EXPORT_PIXELS / (width * height)));
  let clamped = false;
  if (ratio > limit) {
    ratio = Math.max(0.01, Math.floor(limit * 1000) / 1000);
    clamped = ratio < scale;
  }
  return { width: Math.round(width * ratio), height: Math.round(height * ratio), pixelRatio: ratio, clamped };
}

/** Maps a source-image point into output px using the layout. */
export function sourceToOutput(doc: EditorDoc, layout: Layout, x: number, y: number): { x: number; y: number } {
  const box = contentBox(doc);
  return {
    x: layout.content.x + (x - box.x) * layout.content.scale,
    y: layout.content.y + (y - box.y) * layout.content.scale,
  };
}

export function outputToSource(doc: EditorDoc, layout: Layout, x: number, y: number): { x: number; y: number } {
  const box = contentBox(doc);
  return {
    x: box.x + (x - layout.content.x) / layout.content.scale,
    y: box.y + (y - layout.content.y) / layout.content.scale,
  };
}
