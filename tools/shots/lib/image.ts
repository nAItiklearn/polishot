import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ShotSpec } from './manifest.ts';
import { OUT_DIR, SHOTS_PUBLIC_DIR } from './paths.ts';

/**
 * WebP settings for product shots. UI screenshots are mostly flat colour and hairlines, which lossy WebP
 * smears at low quality, so use a high quality with sharp YUV (no chroma subsampling shortcuts).
 */
const WEBP = { quality: 92, effort: 6, smartSubsample: true, alphaQuality: 100 } as const;

export interface WrittenShot {
  name: string;
  file: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * Takes a capture rendered at a higher resolution than the manifest asks for (device scale factor > 1),
 * downsamples it with Lanczos to exactly the manifest size, and writes <name>.webp next to the manifest.
 * Supersampling like this is what keeps text and hairlines crisp at the final size.
 *
 * With `hires`, also writes <name>@2x.webp at twice the manifest size into <dir>/2x/ (unreferenced by
 * the site until someone adds a srcSet), and always writes the untouched source PNG to tools/shots/out/.
 */
export async function writeShot(
  name: string,
  png: Buffer,
  spec: ShotSpec,
  opts: { hires?: boolean; dir?: string } = {},
): Promise<WrittenShot> {
  const dir = opts.dir ?? SHOTS_PUBLIC_DIR;
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.png`), png);

  const src = await sharp(png).metadata();
  if (!src.width || !src.height) throw new Error(`${name}: cannot read the capture's size`);
  const aspect = src.width / src.height;
  const want = spec.width / spec.height;
  if (Math.abs(aspect - want) > 0.01) {
    throw new Error(`${name}: capture is ${src.width}x${src.height} (${aspect.toFixed(3)}) but the manifest wants ${spec.width}x${spec.height} (${want.toFixed(3)})`);
  }

  const out = await sharp(png)
    .resize(spec.width, spec.height, { fit: 'fill', kernel: 'lanczos3' })
    .webp(WEBP)
    .toBuffer();
  const file = join(dir, `${name}.webp`);
  writeFileSync(file, out);

  if (opts.hires) {
    const bigDir = join(dir, '2x');
    mkdirSync(bigDir, { recursive: true });
    const big = await sharp(png)
      .resize(spec.width * 2, spec.height * 2, { fit: 'fill', kernel: 'lanczos3' })
      .webp(WEBP)
      .toBuffer();
    writeFileSync(join(bigDir, `${name}@2x.webp`), big);
  }

  return { name, file, bytes: statSync(file).size, width: spec.width, height: spec.height };
}
