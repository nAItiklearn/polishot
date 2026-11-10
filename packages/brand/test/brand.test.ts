import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME, palette } from '../src/index';

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('palette contrast (WCAG AA)', () => {
  for (const theme of ['light', 'dark'] as const) {
    const p = palette[theme];
    it(`${theme}: body text on bg and surfaces >= 4.5`, () => {
      for (const bg of [p.bg, p.surface, p.surface2]) {
        expect(contrast(p.text, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.text2, bg)).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${theme}: tertiary text >= 4.5 on bg`, () => {
      expect(contrast(p.text3, p.bg)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: accent text >= 4.5 on bg`, () => {
      expect(contrast(p.accentText, p.bg)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: accent button label >= 4.5`, () => {
      expect(contrast(p.accentFg, p.accent)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: focus ring >= 3 on bg (non-text)`, () => {
      expect(contrast(p.focus, p.bg)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('brand sync', () => {
  const root = resolve(__dirname, '../../..');
  const nativeFiles = [
    'apps/desktop/src-tauri/tauri.conf.json',
    'apps/android/app/src/main/java/app/polishot/Brand.kt',
  ];
  for (const f of nativeFiles) {
    it(`${f} uses APP_NAME`, () => {
      const p = resolve(root, f);
      if (!existsSync(p)) return; // app not scaffolded yet
      expect(readFileSync(p, 'utf8')).toContain(`"${APP_NAME}"`);
    });
  }
});
