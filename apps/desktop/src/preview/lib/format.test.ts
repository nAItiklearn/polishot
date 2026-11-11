import { describe, expect, it } from 'vitest';
import {
  basename,
  dirname,
  excerpt,
  exportFilename,
  formatCaptureTime,
  formatDimensions,
  formatFromFilename,
  groupByDay,
  joinPath,
  middleEllipsis,
  plural,
} from './format';

const NOW = Date.UTC(2026, 10, 10, 15, 30); // 10 Nov 2026, 15:30 UTC
const at = (offsetMinutes: number) => NOW + offsetMinutes * 60_000;
const opts = { now: NOW, locale: 'en-US', timeZone: 'UTC' };

describe('formatCaptureTime', () => {
  it('says Today and Yesterday', () => {
    expect(formatCaptureTime(at(-90), opts)).toBe('Today, 2:00 PM');
    expect(formatCaptureTime(at(-60 * 20), opts)).toBe('Yesterday, 7:30 PM');
  });

  it('uses a short date within the year, and the year beyond it', () => {
    expect(formatCaptureTime(Date.UTC(2026, 9, 3, 9, 5), opts)).toBe('Oct 3, 9:05 AM');
    expect(formatCaptureTime(Date.UTC(2025, 11, 31, 23, 0), opts)).toBe('Dec 31, 2025');
  });

  it('compares calendar days, not 24-hour spans', () => {
    // 23:50 the day before is "Yesterday" even though it is only 40 minutes earlier.
    const justAfterMidnight = Date.UTC(2026, 10, 10, 0, 30);
    expect(formatCaptureTime(Date.UTC(2026, 10, 9, 23, 50), { ...opts, now: justAfterMidnight })).toBe('Yesterday, 11:50 PM');
  });
});

describe('paths', () => {
  it('takes the base name from Windows and POSIX paths', () => {
    expect(basename('C:\\Users\\me\\Pictures\\shot.png')).toBe('shot.png');
    expect(basename('/home/me/shot.png')).toBe('shot.png');
    expect(basename('shot.png')).toBe('shot.png');
  });

  it('takes the directory', () => {
    expect(dirname('C:\\Users\\me\\shot.png')).toBe('C:\\Users\\me');
    expect(dirname('shot.png')).toBe('');
  });

  it('shortens long paths in the middle and keeps the file name', () => {
    const p = 'C:\\Users\\Someone\\Pictures\\Screenshots\\Polishot\\polishot-20261110-143005.png';
    const short = middleEllipsis(p, 44);
    expect(short.length).toBeLessThanOrEqual(44);
    expect(short.startsWith('C:\\')).toBe(true);
    expect(short.endsWith('polishot-20261110-143005.png')).toBe(true);
    expect(short).toContain('…');
    expect(middleEllipsis('C:\\a\\b.png', 44)).toBe('C:\\a\\b.png');
  });

  it('joins with the separator the folder already uses', () => {
    expect(joinPath('C:\\Shots', 'a.png')).toBe('C:\\Shots\\a.png');
    expect(joinPath('C:\\Shots\\', 'a.png')).toBe('C:\\Shots\\a.png');
    expect(joinPath('/home/me', 'a.png')).toBe('/home/me/a.png');
    expect(joinPath('', 'a.png')).toBe('a.png');
  });
});

describe('export file names', () => {
  it('names files like the export panel does', () => {
    const d = new Date(2026, 10, 10, 14, 30, 5);
    expect(exportFilename('polishot', 'png', d)).toBe('polishot-20261110-143005.png');
    expect(exportFilename('polishot', 'jpeg', d)).toBe('polishot-20261110-143005.jpg');
    expect(exportFilename('polishot', 'webp', d)).toBe('polishot-20261110-143005.webp');
  });

  it('reads the format from a chosen file name', () => {
    expect(formatFromFilename('a.PNG')).toBe('png');
    expect(formatFromFilename('a.jpg')).toBe('jpeg');
    expect(formatFromFilename('a.jpeg')).toBe('jpeg');
    expect(formatFromFilename('a.webp')).toBe('webp');
    expect(formatFromFilename('a.gif')).toBeNull();
    expect(formatFromFilename('png')).toBeNull();
  });
});

describe('small text helpers', () => {
  it('formats dimensions and plurals', () => {
    expect(formatDimensions(1280, 800)).toBe('1280 × 800');
    expect(plural(1, 'word')).toBe('1 word');
    expect(plural(0, 'word')).toBe('0 words');
    expect(plural(3, 'capture')).toBe('3 captures');
  });

  it('cuts excerpts on a word boundary', () => {
    expect(excerpt('short text')).toBe('short text');
    const long = 'one two three four five six seven eight nine ten eleven twelve';
    const e = excerpt(long, 30);
    expect(e.endsWith('…')).toBe(true);
    expect(e.length).toBeLessThanOrEqual(31);
    expect(excerpt('  lots   of\n\nspace ')).toBe('lots of space');
  });
});

describe('groupByDay', () => {
  const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
  const at = (days: number, hours = 0) => ({ createdAt: NOW - days * 86_400_000 - hours * 3_600_000 });
  const opts = { now: NOW, locale: 'en-US', timeZone: 'UTC' };

  it('names the recent days and then the months', () => {
    const groups = groupByDay([at(0), at(0, 3), at(1), at(3), at(6), at(9), at(20), at(45), at(400)], opts);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      ['Earlier this week', 2],
      ['November 2026', 1],
      ['October 2026', 1],
      ['September 2026', 1],
      ['October 2025', 1],
    ]);
  });

  it('keeps one group per run, so a list extended by paging joins the last group', () => {
    const first = groupByDay([at(0), at(30)], opts);
    const more = groupByDay([at(0), at(30), at(31)], opts);
    expect(first.at(-1)?.items).toHaveLength(1);
    expect(more.at(-1)?.items).toHaveLength(2);
  });

  it('puts a capture from just after midnight with today, not yesterday', () => {
    const justAfterMidnight = { createdAt: Date.UTC(2026, 10, 11, 0, 5) };
    expect(groupByDay([justAfterMidnight], opts)[0]?.label).toBe('Today');
  });

  it('copes with an empty list and with a clock that is slightly behind', () => {
    expect(groupByDay([], opts)).toEqual([]);
    expect(groupByDay([{ createdAt: NOW + 3_600_000 }], opts)[0]?.label).toBe('Today');
  });
});
