import { describe, expect, it } from 'vitest';
import { History } from '../src/history';

interface S {
  n: number;
  tag?: string;
}

describe('History', () => {
  it('undoes and redoes a sequence of edits in order', () => {
    const h = new History<S>({ n: 0 });
    h.push({ n: 1 });
    h.push({ n: 2 });
    h.push({ n: 3 });
    expect(h.present).toEqual({ n: 3 });
    expect(h.undo()).toBe(true);
    expect(h.present).toEqual({ n: 2 });
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(true);
    expect(h.present).toEqual({ n: 0 });
    expect(h.canUndo()).toBe(false);
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(true);
    expect(h.present).toEqual({ n: 1 });
    expect(h.redo()).toBe(true);
    expect(h.redo()).toBe(true);
    expect(h.present).toEqual({ n: 3 });
    expect(h.canRedo()).toBe(false);
    expect(h.redo()).toBe(false);
  });

  it('a new edit clears the redo stack', () => {
    const h = new History<S>({ n: 0 });
    h.push({ n: 1 });
    h.push({ n: 2 });
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.push({ n: 9 });
    expect(h.canRedo()).toBe(false);
    h.undo();
    expect(h.present).toEqual({ n: 1 });
  });

  it('ignores edits that do not change anything', () => {
    const h = new History<S>({ n: 5 });
    expect(h.push({ n: 5 })).toBe(false);
    expect(h.canUndo()).toBe(false);
  });

  it('coalesces a whole transaction into one undo step', () => {
    const h = new History<S>({ n: 0 });
    h.begin();
    for (let i = 1; i <= 50; i++) h.push({ n: i });
    expect(h.present).toEqual({ n: 50 });
    expect(h.undoDepth).toBe(0); // nothing recorded yet
    expect(h.commit()).toBe(true);
    expect(h.undoDepth).toBe(1);
    h.undo();
    expect(h.present).toEqual({ n: 0 });
    h.redo();
    expect(h.present).toEqual({ n: 50 });
  });

  it('an empty transaction records nothing', () => {
    const h = new History<S>({ n: 0 });
    h.begin();
    expect(h.commit()).toBe(false);
    h.begin();
    h.push({ n: 1 });
    h.push({ n: 0 });
    expect(h.commit()).toBe(false);
    expect(h.canUndo()).toBe(false);
  });

  it('rollback restores the state the transaction started from', () => {
    const h = new History<S>({ n: 0 });
    h.push({ n: 1 });
    h.begin();
    h.push({ n: 2 });
    h.push({ n: 3 });
    expect(h.rollback()).toBe(true);
    expect(h.present).toEqual({ n: 1 });
    expect(h.undoDepth).toBe(1);
  });

  it('undo during a transaction commits it first', () => {
    const h = new History<S>({ n: 0 });
    h.begin();
    h.push({ n: 4 });
    h.undo();
    expect(h.present).toEqual({ n: 0 });
    expect(h.inTransaction).toBe(false);
    h.redo();
    expect(h.present).toEqual({ n: 4 });
  });

  it('nested begin() calls do not reset the transaction base', () => {
    const h = new History<S>({ n: 0 });
    h.begin();
    h.push({ n: 1 });
    h.begin();
    h.push({ n: 2 });
    h.commit();
    h.undo();
    expect(h.present).toEqual({ n: 0 });
  });

  it('caps the undo stack at 200 steps, dropping the oldest', () => {
    const h = new History<S>({ n: 0 });
    for (let i = 1; i <= 250; i++) h.push({ n: i });
    expect(h.undoDepth).toBe(200);
    let steps = 0;
    while (h.undo()) steps++;
    expect(steps).toBe(200);
    expect(h.present).toEqual({ n: 50 }); // 250 - 200
  });

  it('the cap also applies to committed transactions', () => {
    const h = new History<S>({ n: 0 });
    for (let i = 1; i <= 230; i++) {
      h.begin();
      h.push({ n: i });
      h.push({ n: i + 1000 });
      h.commit();
    }
    expect(h.undoDepth).toBe(200);
  });

  it('snapshots are isolated from later mutation of what was pushed', () => {
    const h = new History<S>({ n: 0 });
    const s: S = { n: 1 };
    h.push(s);
    s.n = 99;
    expect(h.present).toEqual({ n: 1 });
    h.push({ n: 2 });
    h.undo();
    expect(h.present).toEqual({ n: 1 });
  });

  it('reset clears everything', () => {
    const h = new History<S>({ n: 0 });
    h.push({ n: 1 });
    h.reset({ n: 7 });
    expect(h.present).toEqual({ n: 7 });
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });
});
