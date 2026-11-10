import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getShot, SHOT_NAMES } from './shots';

const root = path.join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' || entry === '.next' ? [] : sourceFiles(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

/** Shot names referenced in JSX: <ProductShot name="..."> and FeatureRow shot="...". */
function referencedShots(): Set<string> {
  const found = new Set<string>();
  for (const file of [...sourceFiles(path.join(root, 'app')), ...sourceFiles(path.join(root, 'components'))]) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/<ProductShot[^>]*?\bname="([a-z0-9-]+)"/g)) found.add(m[1]!);
    for (const m of source.matchAll(/\bshot="([a-z0-9-]+)"/g)) found.add(m[1]!);
  }
  return found;
}

describe('public/shots/manifest.json', () => {
  it('describes every shot with a size, alt text and what must be on screen', () => {
    expect(SHOT_NAMES.length).toBeGreaterThan(0);
    for (const name of SHOT_NAMES) {
      const shot = getShot(name);
      expect(Number.isInteger(shot.width) && shot.width > 0, `${name} width`).toBe(true);
      expect(Number.isInteger(shot.height) && shot.height > 0, `${name} height`).toBe(true);
      expect(shot.alt.length, `${name} alt`).toBeGreaterThan(20);
      expect(shot.show.length, `${name} show`).toBeGreaterThan(40);
      expect(shot.src).toBe(`/shots/${name}.webp`);
    }
  });

  it('lists exactly the shots the pages use', () => {
    const used = referencedShots();
    expect([...used].sort()).toEqual([...SHOT_NAMES].sort());
  });
});
