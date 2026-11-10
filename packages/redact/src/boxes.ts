import { findMatches, type DetectionKind, type Match } from './patterns';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One OCR word in image pixel coordinates. `line` is optional; lines are inferred if absent. */
export interface OcrWord {
  text: string;
  box: Box;
  line?: number;
}

export interface Detection extends Match {
  id: string;
  /** One box per OCR line the match covers, padded slightly so glyph edges are fully hidden. */
  boxes: Box[];
}

export interface DetectOptions {
  kinds?: DetectionKind[];
  /** Padding as a fraction of line height. */
  pad?: number;
}

/** Group words into reading-order lines using vertical overlap when no line index is given. */
export function groupLines(words: OcrWord[]): OcrWord[][] {
  if (words.length === 0) return [];
  if (words.every((w) => typeof w.line === 'number')) {
    const byLine = new Map<number, OcrWord[]>();
    for (const w of words) {
      const arr = byLine.get(w.line!) ?? [];
      arr.push(w);
      byLine.set(w.line!, arr);
    }
    return [...byLine.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, ws]) => ws.sort((a, b) => a.box.x - b.box.x));
  }
  const sorted = [...words].sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));
  const lines: OcrWord[][] = [];
  for (const w of sorted) {
    const cy = w.box.y + w.box.h / 2;
    const line = lines.find((l) => {
      const ref = l[0]!.box;
      return cy >= ref.y && cy <= ref.y + ref.h;
    });
    if (line) line.push(w);
    else lines.push([w]);
  }
  return lines.map((l) => l.sort((a, b) => a.box.x - b.box.x));
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

let seq = 0;

export function detect(words: OcrWord[], opts: DetectOptions = {}): Detection[] {
  const padFrac = opts.pad ?? 0.18;
  const results: Detection[] = [];
  for (const line of groupLines(words)) {
    let text = '';
    const spans: { start: number; end: number; word: OcrWord }[] = [];
    for (const w of line) {
      if (text) text += ' ';
      spans.push({ start: text.length, end: text.length + w.text.length, word: w });
      text += w.text;
    }
    for (const m of findMatches(text)) {
      if (opts.kinds && !opts.kinds.includes(m.kind)) continue;
      let box: Box | null = null;
      for (const s of spans) {
        if (s.end <= m.start || s.start >= m.end) continue;
        const len = Math.max(1, s.end - s.start);
        const a = Math.max(m.start, s.start) - s.start;
        const b = Math.min(m.end, s.end) - s.start;
        const { x, y, w, h } = s.word.box;
        const part: Box = { x: x + (w * a) / len, y, w: (w * (b - a)) / len, h };
        box = box ? union(box, part) : part;
      }
      if (!box) continue;
      const pad = Math.max(2, box.h * padFrac);
      results.push({
        ...m,
        id: `det_${Date.now().toString(36)}_${(seq++).toString(36)}`,
        boxes: [{ x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }],
      });
    }
  }
  return results;
}
