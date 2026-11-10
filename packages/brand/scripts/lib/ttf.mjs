// Minimal TrueType (glyf) reader: just enough to outline a word as SVG path data.
// Supports cmap format 4, hmtx advances, simple and composite glyphs (offset-only transforms).
import { readFileSync } from 'node:fs';

export function loadFont(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => dv.getUint16(o);
  const i16 = (o) => dv.getInt16(o);
  const u32 = (o) => dv.getUint32(o);
  const tables = {};
  const n = u16(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(buf[r], buf[r + 1], buf[r + 2], buf[r + 3]);
    tables[tag] = u32(r + 8);
  }
  for (const t of ['head', 'cmap', 'hhea', 'hmtx', 'loca', 'glyf', 'maxp']) {
    if (tables[t] === undefined) throw new Error(`font is missing table ${t}`);
  }
  const unitsPerEm = u16(tables.head + 18);
  const locFormat = i16(tables.head + 50);
  const numGlyphs = u16(tables.maxp + 4);
  const numHMetrics = u16(tables.hhea + 34);
  const ascender = i16(tables.hhea + 4);
  const descender = i16(tables.hhea + 6);

  // cmap: find a (3,1) or (0,x) format-4 subtable
  const cmapCount = u16(tables.cmap + 2);
  let sub = -1;
  for (let i = 0; i < cmapCount; i++) {
    const r = tables.cmap + 4 + i * 8;
    const pid = u16(r);
    const eid = u16(r + 2);
    const off = tables.cmap + u32(r + 4);
    if (u16(off) === 4 && (pid === 0 || (pid === 3 && eid === 1))) sub = off;
  }
  if (sub < 0) throw new Error('no format-4 cmap');
  const segX2 = u16(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  function glyphId(code) {
    for (let s = 0; s < segX2 / 2; s++) {
      const end = u16(ends + s * 2);
      if (code > end) continue;
      const start = u16(starts + s * 2);
      if (code < start) return 0;
      const delta = i16(deltas + s * 2);
      const ro = u16(ranges + s * 2);
      if (ro === 0) return (code + delta) & 0xffff;
      const g = u16(ranges + s * 2 + ro + (code - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  }
  const advance = (g) => u16(tables.hmtx + Math.min(g, numHMetrics - 1) * 4);
  const loca = (g) => (locFormat === 0 ? u16(tables.loca + g * 2) * 2 : u32(tables.loca + g * 4));

  /** Returns contours: arrays of {x, y, on} in font units (y up). */
  function contours(g, dx = 0, dy = 0) {
    if (g >= numGlyphs) return [];
    const start = loca(g);
    const end = loca(g + 1);
    if (end === start) return [];
    let p = tables.glyf + start;
    const nc = i16(p);
    p += 10;
    if (nc < 0) {
      const out = [];
      let flags;
      do {
        flags = u16(p);
        const comp = u16(p + 2);
        p += 4;
        let a;
        let b;
        if (flags & 1) {
          a = i16(p);
          b = i16(p + 2);
          p += 4;
        } else {
          a = dv.getInt8(p);
          b = dv.getInt8(p + 1);
          p += 2;
        }
        if (flags & 8) p += 2;
        else if (flags & 0x40) p += 4;
        else if (flags & 0x80) p += 8;
        out.push(...contours(comp, dx + a, dy + b));
      } while (flags & 0x20);
      return out;
    }
    const endPts = [];
    for (let i = 0; i < nc; i++) endPts.push(u16(p + i * 2));
    p += nc * 2;
    const insLen = u16(p);
    p += 2 + insLen;
    const count = endPts[nc - 1] + 1;
    const fl = [];
    while (fl.length < count) {
      const f = buf[p++];
      fl.push(f);
      if (f & 8) {
        const rep = buf[p++];
        for (let r = 0; r < rep; r++) fl.push(f);
      }
    }
    const xs = [];
    let v = 0;
    for (const f of fl) {
      if (f & 2) v += f & 16 ? buf[p++] : -buf[p++];
      else if (!(f & 16)) {
        v += i16(p);
        p += 2;
      }
      xs.push(v);
    }
    const ys = [];
    v = 0;
    for (const f of fl) {
      if (f & 4) v += f & 32 ? buf[p++] : -buf[p++];
      else if (!(f & 32)) {
        v += i16(p);
        p += 2;
      }
      ys.push(v);
    }
    const cs = [];
    let s = 0;
    for (const e of endPts) {
      const c = [];
      for (let i = s; i <= e; i++) c.push({ x: xs[i] + dx, y: ys[i] + dy, on: (fl[i] & 1) === 1 });
      cs.push(c);
      s = e + 1;
    }
    return cs;
  }

  return { unitsPerEm, ascender, descender, glyphId, advance, contours };
}

const f2 = (n) => Number(n.toFixed(2)).toString();

/** Converts contours to SVG path data, scaled and flipped (y down), with origin (ox, oy) on the baseline. */
export function contoursToPath(cs, scale, ox, oy) {
  const X = (pt) => f2(ox + pt.x * scale);
  const Y = (pt) => f2(oy - pt.y * scale);
  let d = '';
  for (const c of cs) {
    if (c.length === 0) continue;
    // Expand implied on-curve midpoints.
    const pts = [];
    for (let i = 0; i < c.length; i++) {
      const a = c[i];
      const b = c[(i + 1) % c.length];
      pts.push(a);
      if (!a.on && !b.on) pts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
    }
    let k = pts.findIndex((q) => q.on);
    if (k < 0) continue;
    const ring = [...pts.slice(k), ...pts.slice(0, k)];
    d += `M${X(ring[0])} ${Y(ring[0])}`;
    for (let i = 1; i <= ring.length; i++) {
      const q = ring[i % ring.length];
      if (q.on) d += `L${X(q)} ${Y(q)}`;
      else {
        const nx = ring[(i + 1) % ring.length];
        d += `Q${X(q)} ${Y(q)} ${X(nx)} ${Y(nx)}`;
        i++;
      }
    }
    d += 'Z';
  }
  return d;
}

/**
 * Outlines `text` at `size` px. `tracking` is extra space per letter (em units, e.g. 0.01)
 * and `kern` maps a pair like "Po" to an adjustment in em units. Returns { d, width }.
 */
export function outlineText(font, text, { size, x = 0, baseline = 0, tracking = 0, kern = {} }) {
  const scale = size / font.unitsPerEm;
  let pen = x;
  let d = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const g = font.glyphId(ch.codePointAt(0));
    d += contoursToPath(font.contours(g), scale, pen, baseline);
    pen += font.advance(g) * scale;
    if (i < text.length - 1) pen += (tracking + (kern[ch + text[i + 1]] ?? 0)) * size;
  }
  return { d, width: pen - x };
}
