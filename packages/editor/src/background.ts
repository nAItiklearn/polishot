import { AUTO_ANGLE, NEUTRAL_STOPS, deriveGradient } from './balance';
import { isSafeColor } from './color';
import { isSafeImageSrc } from './doc';
import type { Background } from './types';

export type ResolvedBackground =
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; stops: [string, string]; angle: number }
  | { kind: 'image'; src: string; blur: number }
  | { kind: 'none' };

/**
 * Turns a document background into something directly drawable. The "auto" mode uses the stored stops,
 * or derives them from the stored edge colour, or falls back to warm stone. Unsafe colours and image
 * sources degrade to a neutral gradient instead of reaching the canvas.
 */
export function resolveBackground(bg: Background, origins?: readonly string[]): ResolvedBackground {
  switch (bg.type) {
    case 'auto': {
      const stops =
        bg.stops && isSafeColor(bg.stops[0]) && isSafeColor(bg.stops[1])
          ? bg.stops
          : bg.color && isSafeColor(bg.color)
            ? deriveGradient(bg.color)
            : NEUTRAL_STOPS;
      return { kind: 'gradient', stops, angle: AUTO_ANGLE };
    }
    case 'solid':
      return isSafeColor(bg.color) ? { kind: 'solid', color: bg.color } : { kind: 'gradient', stops: NEUTRAL_STOPS, angle: AUTO_ANGLE };
    case 'gradient':
      return isSafeColor(bg.stops[0]) && isSafeColor(bg.stops[1]) && Number.isFinite(bg.angle)
        ? { kind: 'gradient', stops: bg.stops, angle: bg.angle }
        : { kind: 'gradient', stops: NEUTRAL_STOPS, angle: AUTO_ANGLE };
    case 'image':
      return isSafeImageSrc(bg.src, origins)
        ? { kind: 'image', src: bg.src, blur: Math.min(100, Math.max(0, bg.blur)) }
        : { kind: 'gradient', stops: NEUTRAL_STOPS, angle: AUTO_ANGLE };
    case 'none':
      return { kind: 'none' };
  }
}

/** The colour at the bottom-right of the canvas, used to pick a readable watermark colour. */
export function backgroundCornerColor(resolved: ResolvedBackground): string | null {
  switch (resolved.kind) {
    case 'solid':
      return resolved.color;
    case 'gradient':
      return resolved.stops[1];
    default:
      return null;
  }
}

/**
 * Start and end points of a CSS-style linear gradient (0deg = towards the top, 90deg = towards the right)
 * that exactly spans a w x h box, so the corners get the first and last stop colours.
 */
export function gradientPoints(
  w: number,
  h: number,
  angleDeg: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const cx = w / 2;
  const cy = h / 2;
  return {
    start: { x: cx - dx * half, y: cy - dy * half },
    end: { x: cx + dx * half, y: cy + dy * half },
  };
}

export interface Swatch {
  id: string;
  label: string;
  background: Extract<Background, { type: 'gradient' }>;
}

const sw = (id: string, label: string, a: string, b: string): Swatch => ({
  id,
  label,
  background: { type: 'gradient', stops: [a, b], angle: 160 },
});

/** Curated, restrained backdrops. Warm neutrals first; no purple-to-blue gradients. */
export const SWATCHES: readonly Swatch[] = [
  sw('stone', 'Warm stone', '#dcd8d0', '#bfb9ad'),
  sw('sand', 'Sand', '#ece2cf', '#d6c6a6'),
  sw('sage', 'Sage', '#d0d9c9', '#abbba4'),
  sw('fog', 'Fog', '#e8ebee', '#cbd2d8'),
  sw('clay', 'Muted clay', '#cfa892', '#ac7f69'),
  sw('graphite', 'Graphite', '#4c4c49', '#2e2e2c'),
  sw('ink', 'Ink', '#242422', '#0e0e0d'),
  sw('paper', 'Paper', '#f7f5f0', '#ebe8e0'),
];
