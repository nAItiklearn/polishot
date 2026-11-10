import { describe, expect, it } from 'vitest';
import { validateDoc } from '../src/doc';
import { History } from '../src/history';
import { NUDGE_STEP, NUDGE_STEP_SHIFT, mapSelectionShortcut, mapShortcut } from '../src/shortcuts';
import { duplicateAnnotation, renumberSteps, translateAnnotation } from '../src/tools';
import type { Annotation } from '../src/types';
import { docFor } from './helpers';

const step = (id: string, n: number, x = 10, y = 10): Annotation => ({ id, type: 'step', x, y, n, color: '#e4572e' });
const rect = (id: string): Annotation => ({ id, type: 'rect', x: 5, y: 6, w: 40, h: 30, color: '#e4572e', strokeWidth: 3 });
const stepNumbers = (list: readonly Annotation[]) => list.flatMap((a) => (a.type === 'step' ? [a.n] : []));

describe('renumberSteps', () => {
  it('closes the gap when a step is deleted', () => {
    // Steps 1, 2, 3 and the first one is deleted: 2 and 3 become 1 and 2.
    expect(stepNumbers(renumberSteps([step('b', 2), step('c', 3)]))).toEqual([1, 2]);
    // The middle one is deleted: 1 and 3 become 1 and 2.
    expect(stepNumbers(renumberSteps([step('a', 1), step('c', 3)]))).toEqual([1, 2]);
    // The last one is deleted: nothing to renumber.
    expect(stepNumbers(renumberSteps([step('a', 1), step('b', 2)]))).toEqual([1, 2]);
  });

  it('keeps the visible order, whatever the order in the list', () => {
    const out = renumberSteps([step('x', 7), step('y', 3), step('z', 5)]);
    expect(out.map((a) => [a.id, a.type === 'step' ? a.n : 0])).toEqual([
      ['x', 3],
      ['y', 1],
      ['z', 2],
    ]);
  });

  it('breaks ties by position and handles an empty or step-free list', () => {
    expect(stepNumbers(renumberSteps([step('a', 2), step('b', 2)]))).toEqual([1, 2]);
    expect(renumberSteps([])).toEqual([]);
    const shapes = [rect('r1'), rect('r2')];
    expect(renumberSteps(shapes)).toEqual(shapes);
  });

  it('leaves other annotations (same objects) and never mutates its input', () => {
    const r = rect('r');
    const input = [step('b', 4), r, step('a', 9)];
    const snapshot = JSON.stringify(input);
    const out = renumberSteps(input);
    expect(out[1]).toBe(r);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(stepNumbers(out)).toEqual([1, 2]);
  });

  it('is idempotent', () => {
    const once = renumberSteps([step('a', 2), step('b', 9), rect('r')]);
    expect(renumberSteps(once)).toEqual(once);
  });
});

describe('duplicateAnnotation', () => {
  const all: Annotation[] = [step('s1', 1), step('s2', 2), rect('r1')];

  it('moves the copy and gives it a fresh id, leaving the original untouched', () => {
    const r = all[2]!;
    const before = JSON.stringify(r);
    const copy = duplicateAnnotation(r, all, 12, 12);
    expect(copy.id).not.toBe(r.id);
    expect(copy).toMatchObject({ type: 'rect', x: 17, y: 18, w: 40, h: 30 });
    expect(JSON.stringify(r)).toBe(before);
  });

  it('a duplicated step takes the next free number', () => {
    const copy = duplicateAnnotation(all[0]!, all, 12, 12);
    expect(copy).toMatchObject({ type: 'step', n: 3, x: 22, y: 22 });
  });

  it('a duplicated automatic redaction becomes a manual one', () => {
    const auto: Annotation = { id: 'd1', type: 'blur', x: 1, y: 2, w: 30, h: 8, mode: 'bar', source: 'auto', kind: 'email' };
    const copy = duplicateAnnotation(auto, [auto], 5, 5);
    expect(copy).toMatchObject({ type: 'blur', source: 'manual', mode: 'bar', x: 6, y: 7 });
    expect(copy).not.toHaveProperty('kind');
  });

  it('moves lines, text and brush strokes by the offset', () => {
    const arrow: Annotation = { id: 'a1', type: 'arrow', points: [0, 0, 10, 20], color: '#000000', strokeWidth: 3 };
    expect(duplicateAnnotation(arrow, [arrow], 4, 6)).toMatchObject({ points: [4, 6, 14, 26] });
    const text: Annotation = { id: 't1', type: 'text', x: 3, y: 4, text: 'Hi', fontSize: 20, color: '#111111' };
    expect(duplicateAnnotation(text, [text], 1, 1)).toMatchObject({ x: 4, y: 5, text: 'Hi' });
    const brush: Annotation = { id: 'b1', type: 'redact-brush', points: [1, 1, 5, 5], size: 12, mode: 'blur' };
    expect(duplicateAnnotation(brush, [brush], 2, 3)).toMatchObject({ points: [3, 4, 7, 8] });
  });

  it('every copy is a valid document annotation with a unique id', () => {
    const base = docFor(400, 300);
    const copies = all.map((a) => duplicateAnnotation(a, all, 10, 10));
    const ids = new Set([...all, ...copies].map((a) => a.id));
    expect(ids.size).toBe(all.length * 2);
    expect(validateDoc({ ...base, annotations: [...all, ...copies] })).not.toBeNull();
  });
});

describe('selection shortcuts', () => {
  const key = (k: string, mods: Record<string, boolean> = {}) => mapSelectionShortcut({ key: k, ...mods });

  it('arrow keys nudge by 1 px and Shift+arrow by 10 px', () => {
    expect(NUDGE_STEP).toBe(1);
    expect(NUDGE_STEP_SHIFT).toBe(10);
    expect(key('ArrowLeft')).toEqual({ type: 'nudge', dx: -1, dy: 0 });
    expect(key('ArrowRight')).toEqual({ type: 'nudge', dx: 1, dy: 0 });
    expect(key('ArrowUp')).toEqual({ type: 'nudge', dx: 0, dy: -1 });
    expect(key('ArrowDown')).toEqual({ type: 'nudge', dx: 0, dy: 1 });
    expect(key('ArrowLeft', { shiftKey: true })).toEqual({ type: 'nudge', dx: -10, dy: 0 });
    expect(key('ArrowDown', { shiftKey: true })).toEqual({ type: 'nudge', dx: 0, dy: 10 });
  });

  it('Ctrl+D and Cmd+D duplicate; nothing else does', () => {
    expect(key('d', { ctrlKey: true })).toEqual({ type: 'duplicate' });
    expect(key('D', { ctrlKey: true })).toEqual({ type: 'duplicate' });
    expect(key('d', { metaKey: true })).toEqual({ type: 'duplicate' });
    expect(key('d')).toBeNull();
    expect(key('d', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('d', { ctrlKey: true, altKey: true })).toBeNull();
  });

  it('leaves modified arrows, other keys and the tool shortcuts alone', () => {
    expect(key('ArrowLeft', { ctrlKey: true })).toBeNull();
    expect(key('ArrowLeft', { altKey: true })).toBeNull();
    for (const k of ['a', 'v', 'Delete', 'Escape', 'Enter', 'Tab', ' ', 'Home', 'PageUp']) expect(key(k), k).toBeNull();
  });

  it('does not change what mapShortcut returns (arrows stay unmapped there)', () => {
    expect(mapShortcut({ key: 'ArrowLeft' })).toBeNull();
    expect(mapShortcut({ key: 'd', ctrlKey: true })).toBeNull();
  });
});

describe('History.amend (folding a held key into one step)', () => {
  it('replaces the present without adding an undo step', () => {
    const h = new History<{ n: number }>({ n: 0 });
    expect(h.push({ n: 1 })).toBe(true);
    expect(h.amend({ n: 2 })).toBe(true);
    expect(h.amend({ n: 3 })).toBe(true);
    expect(h.present).toEqual({ n: 3 });
    expect(h.undoDepth).toBe(1);
    expect(h.undo()).toBe(true);
    expect(h.present).toEqual({ n: 0 });
    expect(h.canUndo()).toBe(false);
    h.redo();
    expect(h.present).toEqual({ n: 3 });
  });

  it('does nothing without a step to amend or when nothing changed', () => {
    const h = new History<{ n: number }>({ n: 0 });
    expect(h.amend({ n: 5 })).toBe(false);
    expect(h.present).toEqual({ n: 0 });
    h.push({ n: 1 });
    expect(h.amend({ n: 1 })).toBe(false);
    expect(h.undoDepth).toBe(1);
  });

  it('a held key is one undo step; a later press after another edit is a new one', () => {
    const doc = docFor(400, 300, { annotations: [rect('r')] });
    const h = new History(doc);
    const move = (dx: number) => ({
      ...h.present,
      annotations: h.present.annotations.map((a) => translateAnnotation(a, dx, 0)),
    });
    h.push(move(1));
    h.amend(move(1));
    h.amend(move(1)); // one held key: three presses, one step
    h.push({ ...h.present, padding: 0.1 }); // unrelated edit
    h.push(move(1)); // a fresh press
    expect(h.undoDepth).toBe(3);
    h.undo();
    h.undo();
    const a = h.present.annotations[0]!;
    expect(a.type === 'rect' && a.x).toBe(8);
  });
});
