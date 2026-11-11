import { describe, expect, it } from 'vitest';
import { QUIET_MS, copyPrewarmDelay, type InputActivity } from './useCopyPrewarm';

const at = (over: Partial<InputActivity> = {}): InputActivity => ({
  now: 10_000,
  lastInput: Number.NEGATIVE_INFINITY,
  pointerDown: false,
  inputPending: false,
  ...over,
});

describe('copyPrewarmDelay (when the Copy image may be prepared)', () => {
  it('starts at once when the user has not touched anything', () => {
    expect(copyPrewarmDelay(at())).toBe(0);
  });

  it('waits out the quiet spell after the last pointer, key or wheel event', () => {
    expect(copyPrewarmDelay(at({ lastInput: 9_900 }))).toBe(QUIET_MS - 100);
    expect(copyPrewarmDelay(at({ lastInput: 10_000 }))).toBe(QUIET_MS);
    expect(copyPrewarmDelay(at({ lastInput: 10_000 - QUIET_MS }))).toBe(0);
    expect(copyPrewarmDelay(at({ lastInput: 1_000 }))).toBe(0);
  });

  it('never starts with a button held down: a drag is under way', () => {
    expect(copyPrewarmDelay(at({ pointerDown: true }))).toBeGreaterThan(0);
    // Even if the last event was long ago (a held button with a still hand).
    expect(copyPrewarmDelay(at({ pointerDown: true, lastInput: 0 }))).toBeGreaterThan(0);
  });

  it('defers briefly while the browser reports input waiting', () => {
    const d = copyPrewarmDelay(at({ inputPending: true }));
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(QUIET_MS);
  });

  it('takes the quiet time as a parameter, so a test can shorten it', () => {
    expect(copyPrewarmDelay(at({ lastInput: 9_900 }), 150)).toBe(50);
    expect(copyPrewarmDelay(at({ lastInput: 9_900 }), 50)).toBe(0);
  });
});
