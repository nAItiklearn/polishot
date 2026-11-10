// Geometry of the Polishot mark ("Print P"), defined once on a 64-unit grid.
// A P whose bowl is a print (the screenshot, persimmon) tilted -6 deg and pinned onto
// an ink stem. The bowl's counter is a real knockout, so the mark works on any background
// and collapses to a clean single-colour P for mono use.
//
// Grid (64 x 64, 1 unit = 0.25 px at 16 px):
//   stem   x 13..23 (10u = 2.5 px @16), y 25..55, r 3
//   print  x 13..53, y 8..39 (40 x 31), r 7.5, rotated -6 deg around its centre
//   window x 24..45, y 16..31 (21 x 15), r 2.5  -> frame 11/8/8/8 (left heavier: optical
//          compensation for the stem tucking underneath and the tilt lifting the right side)
// Everything is then shifted by OFFSET so the optical centre sits on (32, 32).

export const INK = '#161615';
export const INK_DARK = '#EDECE8';
export const ACCENT = '#C8471D';
export const ACCENT_DARK = '#EE7444';

const TILT = -6;
const STEM = { x: 13, y: 25, w: 10, h: 30, r: 3 };
const PRINT = { x: 13, y: 8, w: 40, h: 31, r: 7.5 };
const WINDOW = { x: 24, y: 16, w: 21, h: 15, r: 2.5 };
const PIVOT = { x: PRINT.x + PRINT.w / 2, y: PRINT.y + PRINT.h / 2 };
// Measured bbox of the raw geometry is about x 12.9..54.6, y 5.8..55; nudge to centre it
// in the 64 box (slightly high, which reads as centred because the print is heavier on top).
export const OFFSET = { x: -1.5, y: 1.6 };

const f = (n) => {
  const v = Math.round(n * 1000) / 1000;
  return (Object.is(v, -0) ? 0 : v).toString();
};

/** Affine helper: rotate (deg) about pivot, then scale and translate. */
function makeXf({ rot = 0, pivot = { x: 0, y: 0 }, s = 1, tx = 0, ty = 0 }) {
  const a = (rot * Math.PI) / 180;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  return (x, y) => {
    const dx = x - pivot.x;
    const dy = y - pivot.y;
    const rx = pivot.x + dx * c - dy * sn;
    const ry = pivot.y + dx * sn + dy * c;
    return [(rx + OFFSET.x) * s + tx, (ry + OFFSET.y) * s + ty];
  };
}

/** Rounded rectangle as absolute path data with the transform baked in (arcs stay circular). */
function roundRect({ x, y, w, h, r }, xf, s) {
  const R = f(r * s);
  const P = (px, py) => xf(px, py).map(f).join(' ');
  return (
    `M${P(x + r, y)}L${P(x + w - r, y)}A${R} ${R} 0 0 1 ${P(x + w, y + r)}` +
    `L${P(x + w, y + h - r)}A${R} ${R} 0 0 1 ${P(x + w - r, y + h)}` +
    `L${P(x + r, y + h)}A${R} ${R} 0 0 1 ${P(x, y + h - r)}` +
    `L${P(x, y + r)}A${R} ${R} 0 0 1 ${P(x + r, y)}Z`
  );
}

/**
 * Returns path data for the mark placed at (tx, ty) with scale s (64 grid -> s * 64 px).
 * stem: ink. print: accent, use fill-rule evenodd (outer + window). mono: single evenodd path.
 */
export function markPaths({ s = 1, tx = 0, ty = 0 } = {}) {
  const straight = makeXf({ s, tx, ty });
  const tilted = makeXf({ rot: TILT, pivot: PIVOT, s, tx, ty });
  const stem = roundRect(STEM, straight, s);
  const outer = roundRect(PRINT, tilted, s);
  const hole = roundRect(WINDOW, tilted, s);
  return { stem, print: outer + hole, outer, hole };
}

/** Two-colour mark as SVG elements (no wrapper). */
export function markElements(opts = {}, { ink = INK, accent = ACCENT } = {}) {
  const p = markPaths(opts);
  return `<path fill="${ink}" d="${p.stem}"/><path fill="${accent}" fill-rule="evenodd" d="${p.print}"/>`;
}

/** Single-colour mark (tray, favicons in mono contexts, Android themed icon). The stem never
 * touches the window, so stem + evenodd print gives a clean P silhouette with a knocked-out counter. */
export function monoElements(opts = {}, color = INK) {
  const p = markPaths(opts);
  return `<path fill="${color}" d="${p.stem}"/><path fill="${color}" fill-rule="evenodd" d="${p.print}"/>`;
}

export const svgDoc = (w, h, body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${extra}>${body}</svg>\n`;
