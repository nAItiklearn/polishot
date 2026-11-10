import { computeExportSize, type ExportSize } from './layout';
import type { EditorDoc, ExportOptions } from './types';
import { shouldWatermark } from './watermark';

export interface ExportPlan {
  size: ExportSize;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Encoder quality, or undefined for PNG. */
  quality: number | undefined;
  /** Opaque colour painted behind the canvas (JPEG has no alpha channel). */
  matte: string | null;
  watermark: boolean;
}

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

/**
 * Turns user-facing export options into concrete parameters. Pure, so the size maths and the licence
 * gate can be tested without a canvas. Unknown values fall back to safe defaults (PNG, 1x, watermark on).
 */
export function planExport(doc: EditorDoc, opts: ExportOptions): ExportPlan {
  const format = opts.format === 'jpeg' || opts.format === 'webp' ? opts.format : 'png';
  const scale = opts.scale === 2 || opts.scale === 3 ? opts.scale : 1;
  const q = Number.isFinite(opts.quality) ? Math.min(1, Math.max(0.05, opts.quality)) : 0.92;
  return {
    size: computeExportSize(doc, scale),
    mime: MIME[format],
    quality: format === 'png' ? undefined : q,
    matte: format === 'jpeg' ? '#ffffff' : null,
    watermark: shouldWatermark(opts.licensed),
  };
}
