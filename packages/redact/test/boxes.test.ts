import { describe, expect, it } from 'vitest';
import { detect, groupLines, type OcrWord } from '../src';

const word = (text: string, x: number, y: number, w = text.length * 10, h = 20): OcrWord => ({
  text,
  box: { x, y, w, h },
});

describe('groupLines', () => {
  it('infers lines from vertical overlap and sorts by x', () => {
    const lines = groupLines([word('b', 50, 2), word('a', 0, 0), word('c', 0, 40)]);
    expect(lines.map((l) => l.map((w) => w.text))).toEqual([['a', 'b'], ['c']]);
  });
  it('uses explicit line indexes', () => {
    const lines = groupLines([{ ...word('x', 0, 0), line: 1 }, { ...word('y', 0, 100), line: 0 }]);
    expect(lines.map((l) => l[0]!.text)).toEqual(['y', 'x']);
  });
});

describe('detect', () => {
  it('maps a card split across OCR words to one padded box', () => {
    const words = ['Card', '4111', '1111', '1111', '1111'].map((t, i) => word(t, i * 60, 10, 40, 20));
    const [d] = detect(words);
    expect(d?.kind).toBe('card');
    expect(d!.boxes).toHaveLength(1);
    const b = d!.boxes[0]!;
    expect(b.x).toBeLessThan(60);
    expect(b.x + b.w).toBeGreaterThan(280);
    expect(b.x).toBeGreaterThan(40); // does not cover the word "Card"
  });
  it('covers only the matching part of a word', () => {
    const [d] = detect([word('email:jo@ex.com', 0, 0, 160, 20)]);
    expect(d?.kind).toBe('email');
    expect(d!.boxes[0]!.x).toBeGreaterThan(40);
  });
  it('filters by kind', () => {
    const words = [word('8.8.8.8', 0, 0), word('a@b.co', 100, 0)];
    expect(detect(words, { kinds: ['email'] }).map((d) => d.kind)).toEqual(['email']);
  });
});
