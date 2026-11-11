/**
 * Real product screenshots for the website.
 *
 *   pnpm shots                         regenerate everything
 *   pnpm shots -- --only balance,ocr   regenerate some shots
 *   pnpm shots:verify                  only check that every manifest entry exists at its exact size
 *
 * What it does:
 *   1. renders the sample "captures" (tools/shots/samples/*.html -> samples/out/*.png + OCR word boxes),
 *   2. starts the desktop UI (mock mode) and the editor playground dev servers unless they are already
 *      running (desktop: http://127.0.0.1:3200, playground: http://127.0.0.1:5199),
 *   3. drives them with Playwright at a high device scale factor, using the apps' own controls,
 *   4. downsamples each capture to the exact size in apps/web/public/shots/manifest.json and writes
 *      apps/web/public/shots/<name>.webp (full-resolution PNGs land in tools/shots/out/ for review).
 *
 * Options:
 *   --only a,b      only these shots (names from manifest.json)
 *   --theme dark|light   colour scheme of the product UI in app shots (default: dark)
 *   --out <dir>     write the .webp files here instead of apps/web/public/shots (to try something out)
 *   --hires         also write <name>@2x.webp (twice the manifest size) to <out>/2x/
 *   --verify-only   do not capture, only verify the files on disk
 *   --keep-servers  leave dev servers that this script started running
 *
 * Re-runnable: the output depends only on the repo (UI code, samples, manifest), not on the clock or on
 * existing files. The site's pages are statically rendered, so rebuild the web app after regenerating.
 */
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeShot, type WrittenShot } from './lib/image.ts';
import { loadManifest, verifyShots } from './lib/manifest.ts';
import { SHOTS_PUBLIC_DIR } from './lib/paths.ts';
import { DESKTOP_SERVER, PLAYGROUND_SERVER, Servers } from './lib/servers.ts';
import { renderSamples, SAMPLE_NAMES, type SampleMeta, type SampleName } from './samples/render.ts';
import { balance } from './shots/balance.ts';
import { exportShot } from './shots/export.ts';
import { heroAfter } from './shots/heroAfter.ts';
import { heroBefore } from './shots/heroBefore.ts';
import { ocr } from './shots/ocr.ts';
import { quickSend } from './shots/quickSend.ts';
import { redact } from './shots/redact.ts';
import type { ShotCtx, ShotDef } from './shots/types.ts';

const ALL_SHOTS: ShotDef[] = [heroBefore, heroAfter, balance, redact, ocr, exportShot, quickSend];

/** Shots that need the desktop UI dev server / the editor playground dev server. */
const NEEDS_DESKTOP = new Set(['balance', 'redact', 'ocr', 'export', 'quick-send']);
const NEEDS_PLAYGROUND = new Set(['hero-after']);

const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    theme: { type: 'string', default: 'dark' },
    out: { type: 'string' },
    hires: { type: 'boolean', default: false },
    'verify-only': { type: 'boolean', default: false },
    'keep-servers': { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const manifest = loadManifest();
const outDir = values.out ? resolve(values.out) : SHOTS_PUBLIC_DIR;

if (values['verify-only']) {
  const rows = await verifyShots(manifest, undefined, outDir);
  for (const r of rows) console.log(`${r.ok ? 'ok     ' : 'PROBLEM'} ${r.name.padEnd(12)} ${r.message}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

const theme = values.theme === 'light' ? 'light' : 'dark';
const wanted = values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
for (const name of wanted ?? []) {
  if (!ALL_SHOTS.some((s) => s.name === name)) throw new Error(`unknown shot "${name}". Known: ${ALL_SHOTS.map((s) => s.name).join(', ')}`);
}
const shots = ALL_SHOTS.filter((s) => !wanted || wanted.includes(s.name));
for (const s of shots) {
  if (!manifest.shots[s.name]) throw new Error(`"${s.name}" is not in manifest.json`);
}
for (const name of Object.keys(manifest.shots)) {
  if (!ALL_SHOTS.some((s) => s.name === name)) console.warn(`warning: manifest.json lists "${name}" but tools/shots has no recipe for it`);
}

const servers = new Servers();
const written: WrittenShot[] = [];
const failures: string[] = [];
const started = Date.now();

try {
  console.log('Rendering samples');
  const metas = await renderSamples(SAMPLE_NAMES);
  const samples = Object.fromEntries(metas.map((m) => [m.name, m])) as Record<SampleName, SampleMeta>;

  console.log('Dev servers');
  if (shots.some((s) => NEEDS_DESKTOP.has(s.name))) await servers.ensure(DESKTOP_SERVER);
  if (shots.some((s) => NEEDS_PLAYGROUND.has(s.name))) await servers.ensure(PLAYGROUND_SERVER);

  const browser = await chromium.launch();
  try {
    const ctx: ShotCtx = { browser, manifest, theme, samples };
    console.log('Capturing');
    for (const shot of shots) {
      const t0 = Date.now();
      try {
        const png = await shot.run(ctx);
        const result = await writeShot(shot.name, png, manifest.shots[shot.name]!, { hires: values.hires, dir: outDir });
        written.push(result);
        console.log(`  ${shot.name.padEnd(12)} ${result.width}x${result.height}  ${(result.bytes / 1024).toFixed(0).padStart(4)} KB  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      } catch (e) {
        failures.push(shot.name);
        console.error(`  ${shot.name.padEnd(12)} FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  if (!values['keep-servers']) servers.stop();
}

const rows = await verifyShots(manifest, wanted ?? undefined, outDir);
const bad = rows.filter((r) => !r.ok);
console.log(`\n${written.length} shot(s) written in ${((Date.now() - started) / 1000).toFixed(0)} s, ${bad.length + failures.length} problem(s).`);
for (const r of bad) console.error(`  ${r.name}: ${r.message}`);
process.exit(bad.length === 0 && failures.length === 0 ? 0 : 1);
