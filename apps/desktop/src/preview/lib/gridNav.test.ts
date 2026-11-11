import { describe, expect, it } from 'vitest';
import { isGridKey, neighbour, type CellRect } from './gridNav';

/** Three columns of 100 px cards, 8 px apart, rows 120 px tall. */
const grid = (count: number, startTop = 0): CellRect[] =>
  Array.from({ length: count }, (_, i) => ({ top: startTop + Math.floor(i / 3) * 120, left: (i % 3) * 108, width: 100 }));

describe('neighbour', () => {
  const g = grid(8); // rows of 3, 3, 2

  it('steps through the reading order with left and right, and stops at the ends', () => {
    expect(neighbour(g, 1, 'ArrowRight')).toBe(2);
    expect(neighbour(g, 2, 'ArrowRight')).toBe(3); // wraps to the next row, like reading
    expect(neighbour(g, 3, 'ArrowLeft')).toBe(2);
    expect(neighbour(g, 0, 'ArrowLeft')).toBe(0);
    expect(neighbour(g, 7, 'ArrowRight')).toBe(7);
  });

  it('moves straight down and up in the same column', () => {
    expect(neighbour(g, 1, 'ArrowDown')).toBe(4);
    expect(neighbour(g, 4, 'ArrowDown')).toBe(7);
    expect(neighbour(g, 7, 'ArrowUp')).toBe(4);
    expect(neighbour(g, 4, 'ArrowUp')).toBe(1);
  });

  it('goes to the nearest card when the row below is shorter', () => {
    // Index 5 is in the third column; the last row has only two cards, so the closest is the second one.
    expect(neighbour(g, 5, 'ArrowDown')).toBe(7);
  });

  it('stays put at the top and bottom edges', () => {
    expect(neighbour(g, 1, 'ArrowUp')).toBe(1);
    expect(neighbour(g, 7, 'ArrowDown')).toBe(7);
  });

  it('jumps to the first and last card', () => {
    expect(neighbour(g, 4, 'Home')).toBe(0);
    expect(neighbour(g, 4, 'End')).toBe(7);
  });

  it('works across grids stacked under headings (a gap between rows)', () => {
    const stacked = [...grid(3), ...grid(3, 300)];
    expect(neighbour(stacked, 2, 'ArrowDown')).toBe(5);
    expect(neighbour(stacked, 3, 'ArrowUp')).toBe(0);
  });

  it('ignores sub-pixel differences between cards of one row', () => {
    const wobbly: CellRect[] = [
      { top: 0, left: 0, width: 100 },
      { top: 0.4, left: 108, width: 100 },
      { top: 120, left: 0, width: 100 },
    ];
    expect(neighbour(wobbly, 1, 'ArrowDown')).toBe(2);
    expect(neighbour(wobbly, 0, 'ArrowRight')).toBe(1);
  });

  it('copes with an empty or one-card grid', () => {
    expect(neighbour([], 0, 'ArrowDown')).toBe(0);
    expect(neighbour(grid(1), 0, 'ArrowDown')).toBe(0);
    expect(neighbour(grid(1), 0, 'ArrowRight')).toBe(0);
  });

  it('recognises only the navigation keys', () => {
    expect(isGridKey('ArrowUp')).toBe(true);
    expect(isGridKey('Enter')).toBe(false);
  });
});
