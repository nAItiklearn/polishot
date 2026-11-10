import { describe, expect, it } from 'vitest';
import { findMatches } from '../src';
import positive from '../fixtures/positive.json';
import negative from '../fixtures/negative.json';

interface Fixture {
  text: string;
  expect: { kind: string; value: string }[];
}

describe('fixture corpus size', () => {
  it('has at least 50 positive and 50 negative samples', () => {
    expect((positive as Fixture[]).length).toBeGreaterThanOrEqual(50);
    expect((negative as Fixture[]).length).toBeGreaterThanOrEqual(50);
  });
});

describe('positive fixtures', () => {
  for (const f of positive as Fixture[]) {
    it(f.text.slice(0, 70), () => {
      const got = findMatches(f.text).map((m) => ({ kind: m.kind, value: m.value }));
      expect(got).toEqual(f.expect);
    });
  }
});

describe('negative fixtures', () => {
  for (const f of negative as Fixture[]) {
    it(f.text.slice(0, 70), () => {
      expect(findMatches(f.text)).toEqual([]);
    });
  }
});
