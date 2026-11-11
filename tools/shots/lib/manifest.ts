import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { MANIFEST_PATH, SHOTS_PUBLIC_DIR } from './paths.ts';

export interface ShotSpec {
  width: number;
  height: number;
  alt: string;
  show: string;
}

export interface Manifest {
  format: string;
  shots: Record<string, ShotSpec>;
}

export function loadManifest(): Manifest {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  if (raw.format !== 'webp') throw new Error(`manifest.json: expected format "webp", found "${raw.format}"`);
  return raw;
}

export interface VerifyRow {
  name: string;
  ok: boolean;
  message: string;
}

/** Checks that every shot in the manifest exists as a .webp of exactly the declared size. */
export async function verifyShots(manifest: Manifest, names?: readonly string[], dir: string = SHOTS_PUBLIC_DIR): Promise<VerifyRow[]> {
  const rows: VerifyRow[] = [];
  for (const [name, spec] of Object.entries(manifest.shots)) {
    if (names && !names.includes(name)) continue;
    const file = join(dir, `${name}.${manifest.format}`);
    try {
      const meta = await sharp(file).metadata();
      const sizeOk = meta.width === spec.width && meta.height === spec.height && meta.format === 'webp';
      rows.push({
        name,
        ok: sizeOk,
        message: sizeOk
          ? `${meta.width}x${meta.height}`
          : `expected ${spec.width}x${spec.height} webp, found ${meta.width}x${meta.height} ${meta.format}`,
      });
    } catch {
      rows.push({ name, ok: false, message: 'missing' });
    }
  }
  return rows;
}
