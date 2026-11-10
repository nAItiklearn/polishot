import type { FrameId } from './types';

/**
 * Original frame designs, described as plain data so layout and rendering share one source of truth.
 * All numbers are in source-image pixels at content scale 1 and relative to the framed object's top-left.
 */

export interface Insets {
  t: number;
  r: number;
  b: number;
  l: number;
}

export type Radii = number | [number, number, number, number];

export type ShapeSpec =
  | {
      t: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      r?: Radii;
      fill?: string;
      stroke?: string;
      sw?: number;
      /** Vertical two-stop gradient, top to bottom. */
      grad?: [string, string];
    }
  | { t: 'circle'; x: number; y: number; r: number; fill: string }
  | { t: 'line'; points: number[]; stroke: string; sw: number };

export interface FrameSpec {
  insets: Insets;
  /** Drawing unit; scales chrome with the image resolution. */
  u: number;
  /** Shapes painted under the image. */
  under: ShapeSpec[];
  /** Corner radius (source px) for clipping the image alone, or null when the outer shape is clipped instead. */
  imageRadius: number | null;
  /** True when the whole framed shape is clipped with the document corner radius (none, bar frames). */
  outerClip: boolean;
  /** Outline of the framed object, used for the shadow. `r` of null means "use the document radius". */
  outline: { x: number; y: number; w: number; h: number; r: number | null };
}

export const FRAME_IDS: FrameId[] = ['none', 'browser-light', 'browser-dark', 'window', 'phone', 'laptop'];

export const FRAME_LABELS: Record<FrameId, string> = {
  none: 'None',
  'browser-light': 'Browser',
  'browser-dark': 'Browser dark',
  window: 'Window',
  phone: 'Phone',
  laptop: 'Laptop',
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const R = Math.round;

const BROWSER = {
  light: { bar: '#ecebe8', hair: '#d9d7d2', dot: '#cfcdc7', pill: '#f8f7f5', pillLine: '#cbc9c3', icon: '#d4d2cc' },
  dark: { bar: '#262624', hair: '#383835', dot: '#4b4a46', pill: '#191918', pillLine: '#4f4e4a', icon: '#43423f' },
};

export function frameSpec(frame: FrameId, cw: number, ch: number): FrameSpec {
  const u = clamp(Math.max(cw, ch) / 1200, 0.75, 2.2);
  switch (frame) {
    case 'browser-light':
    case 'browser-dark': {
      const c = frame === 'browser-dark' ? BROWSER.dark : BROWSER.light;
      const bar = R(40 * u);
      const fw = cw;
      const pw = clamp(fw * 0.42, 140 * u, 560 * u);
      const ph = R(24 * u);
      const px = (fw - pw) / 2;
      const py = (bar - ph) / 2;
      const cy = bar / 2;
      const under: ShapeSpec[] = [
        { t: 'rect', x: 0, y: 0, w: fw, h: bar, fill: c.bar },
        { t: 'rect', x: 0, y: bar - 1, w: fw, h: 1, fill: c.hair },
        { t: 'circle', x: R(22 * u), y: cy, r: 5 * u, fill: c.dot },
        { t: 'circle', x: R(40 * u), y: cy, r: 5 * u, fill: c.dot },
        { t: 'circle', x: R(58 * u), y: cy, r: 5 * u, fill: c.dot },
        { t: 'rect', x: px, y: py, w: pw, h: ph, r: ph / 2, fill: c.pill },
        { t: 'circle', x: px + 15 * u, y: cy, r: 3.5 * u, fill: c.icon },
        {
          t: 'rect',
          x: px + 28 * u,
          y: cy - 2.5 * u,
          w: Math.min(pw * 0.36, 180 * u),
          h: 5 * u,
          r: 2.5 * u,
          fill: c.pillLine,
        },
      ];
      return {
        insets: { t: bar, r: 0, b: 0, l: 0 },
        u,
        under,
        imageRadius: null,
        outerClip: true,
        outline: { x: 0, y: 0, w: fw, h: bar + ch, r: null },
      };
    }
    case 'window': {
      const bar = R(32 * u);
      const cy = bar / 2;
      const fw = cw;
      const c = BROWSER.light;
      const under: ShapeSpec[] = [
        { t: 'rect', x: 0, y: 0, w: fw, h: bar, fill: '#f2f1ee' },
        { t: 'rect', x: 0, y: bar - 1, w: fw, h: 1, fill: c.hair },
        { t: 'rect', x: R(14 * u), y: cy - 6 * u, w: 12 * u, h: 12 * u, r: 3 * u, fill: c.dot },
        {
          t: 'rect',
          x: R(34 * u),
          y: cy - 3 * u,
          w: clamp(fw * 0.16, 56 * u, 180 * u),
          h: 6 * u,
          r: 3 * u,
          fill: c.pillLine,
        },
        { t: 'line', points: [fw - 70 * u, cy, fw - 60 * u, cy], stroke: c.pillLine, sw: 1.5 * u },
        { t: 'rect', x: fw - 44 * u, y: cy - 4.5 * u, w: 9 * u, h: 9 * u, r: 1.5 * u, stroke: c.pillLine, sw: 1.5 * u },
        { t: 'line', points: [fw - 24 * u, cy - 4.5 * u, fw - 15 * u, cy + 4.5 * u], stroke: c.pillLine, sw: 1.5 * u },
        { t: 'line', points: [fw - 15 * u, cy - 4.5 * u, fw - 24 * u, cy + 4.5 * u], stroke: c.pillLine, sw: 1.5 * u },
      ];
      return {
        insets: { t: bar, r: 0, b: 0, l: 0 },
        u,
        under,
        imageRadius: null,
        outerClip: true,
        outline: { x: 0, y: 0, w: fw, h: bar + ch, r: null },
      };
    }
    case 'phone': {
      const bz = R(14 * u);
      const top = R(18 * u);
      const rOut = R(46 * u);
      const rIn = Math.max(4, rOut - bz);
      const fw = cw + 2 * bz;
      const fh = ch + top + bz;
      const under: ShapeSpec[] = [
        { t: 'rect', x: 0, y: 0, w: fw, h: fh, r: rOut, fill: '#171716', stroke: '#3b3b38', sw: 1.5 * u },
        { t: 'rect', x: fw / 2 - 26 * u, y: top / 2 - 3 * u, w: 52 * u, h: 6 * u, r: 3 * u, fill: '#2b2b29' },
      ];
      return {
        insets: { t: top, r: bz, b: bz, l: bz },
        u,
        under,
        imageRadius: rIn,
        outerClip: false,
        outline: { x: 0, y: 0, w: fw, h: fh, r: rOut },
      };
    }
    case 'laptop': {
      const bz = R(14 * u);
      const top = R(16 * u);
      const bot = R(20 * u);
      const overhang = R(28 * u);
      const baseH = R(14 * u);
      const bodyW = cw + 2 * bz;
      const bodyH = ch + top + bot;
      const fw = bodyW + 2 * overhang;
      const rOut = R(14 * u);
      const under: ShapeSpec[] = [
        {
          t: 'rect',
          x: overhang,
          y: 0,
          w: bodyW,
          h: bodyH,
          r: [rOut, rOut, R(5 * u), R(5 * u)],
          fill: '#171716',
          stroke: '#3b3b38',
          sw: 1.5 * u,
        },
        { t: 'circle', x: overhang + bodyW / 2, y: top / 2, r: 2.2 * u, fill: '#2f2f2c' },
        { t: 'rect', x: 0, y: bodyH, w: fw, h: baseH, r: [0, 0, baseH * 0.8, baseH * 0.8], grad: ['#dcdad5', '#b8b6b0'] },
        { t: 'rect', x: fw / 2 - 44 * u, y: bodyH, w: 88 * u, h: 4.5 * u, r: [0, 0, 3 * u, 3 * u], fill: '#a3a19b' },
      ];
      return {
        insets: { t: top, r: overhang + bz, b: bot + baseH, l: overhang + bz },
        u,
        under,
        imageRadius: R(3 * u),
        outerClip: false,
        outline: { x: 0, y: 0, w: fw, h: bodyH + baseH, r: rOut },
      };
    }
    case 'none':
    default:
      return {
        insets: { t: 0, r: 0, b: 0, l: 0 },
        u,
        under: [],
        imageRadius: null,
        outerClip: true,
        outline: { x: 0, y: 0, w: cw, h: ch, r: null },
      };
  }
}
