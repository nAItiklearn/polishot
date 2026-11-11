/**
 * Arrow-key movement over a grid of cards whose columns are not known in advance (the history grid
 * reflows with the window). Works from where the cards actually are, so it also copes with several
 * grids stacked under headings, and with a last row that is not full.
 */

export interface CellRect {
  top: number;
  left: number;
  width: number;
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export const GRID_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

/** Cells whose tops differ by less than this are on the same row. */
const ROW_TOLERANCE = 4;

export function isGridKey(key: string): key is GridKey {
  return GRID_KEYS.includes(key);
}

/**
 * The index to move to from `from`, or `from` itself when there is nowhere to go. Left and right step
 * through the reading order; up and down go to the nearest card in the adjacent row, by horizontal centre.
 */
export function neighbour(cells: readonly CellRect[], from: number, key: GridKey): number {
  const n = cells.length;
  if (n === 0 || from < 0 || from >= n) return Math.max(0, Math.min(from, n - 1));
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return n - 1;
    case 'ArrowLeft':
      return Math.max(0, from - 1);
    case 'ArrowRight':
      return Math.min(n - 1, from + 1);
    case 'ArrowDown':
    case 'ArrowUp': {
      const cur = cells[from]!;
      const dir = key === 'ArrowDown' ? 1 : -1;
      // The adjacent row: the closest top in that direction.
      let rowTop: number | null = null;
      for (const c of cells) {
        const d = (c.top - cur.top) * dir;
        if (d > ROW_TOLERANCE && (rowTop === null || d < (rowTop - cur.top) * dir)) rowTop = c.top;
      }
      if (rowTop === null) return from;
      const centre = cur.left + cur.width / 2;
      let best = from;
      let bestDist = Number.POSITIVE_INFINITY;
      cells.forEach((c, i) => {
        if (Math.abs(c.top - rowTop!) > ROW_TOLERANCE) return;
        const dist = Math.abs(c.left + c.width / 2 - centre);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    }
  }
}
