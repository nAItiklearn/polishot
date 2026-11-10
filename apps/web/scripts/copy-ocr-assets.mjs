#!/usr/bin/env node
/**
 * Self-hosts the on-device OCR engine used by /editor, so nothing is fetched from a CDN at runtime.
 *
 *   node scripts/copy-ocr-assets.mjs           copy + download whatever is missing or changed
 *   node scripts/copy-ocr-assets.mjs --check   verify public/ocr and exit 1 if anything is off
 *
 * Output (apps/web/public/ocr):
 *   worker.min.js                         from tesseract.js/dist (copied from node_modules)
 *   tesseract-core-simd-lstm.wasm.js      from tesseract.js-core (copied; the wasm is embedded in this file)
 *   eng.traineddata                       DOWNLOADED, see TRAINEDDATA below; SHA-256 is checked
 *   NOTICE.txt                            licences and provenance
 *
 * Only the LSTM, SIMD build of the core is shipped. Every browser from 2023 on supports WebAssembly SIMD,
 * and `ocr.ts` points tesseract.js straight at this file, so its own CDN-based detection never runs.
 * The packages' versions come from the lockfile (tesseract.js is pinned to an exact version in package.json).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(appDir, 'public', 'ocr');
const checkOnly = process.argv.includes('--check');

/**
 * English LSTM model, "fast" variant (4.1 MB). Pinned to the 4.1.0 tag of the tesseract-ocr/tessdata_fast
 * repository (Apache-2.0) and verified by SHA-256 after download, so a moved branch or a tampered mirror
 * cannot change what ships.
 */
const TRAINEDDATA = {
  url: 'https://github.com/tesseract-ocr/tessdata_fast/raw/4.1.0/eng.traineddata',
  sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
  bytes: 4113088,
};

const require = createRequire(import.meta.url);
const tessDir = path.dirname(require.resolve('tesseract.js/package.json'));
const coreDir = path.dirname(
  createRequire(path.join(tessDir, 'package.json')).resolve('tesseract.js-core/package.json'),
);
const tessVersion = JSON.parse(await readFile(path.join(tessDir, 'package.json'), 'utf8')).version;
const coreVersion = JSON.parse(await readFile(path.join(coreDir, 'package.json'), 'utf8')).version;

const COPIES = [
  { from: path.join(tessDir, 'dist', 'worker.min.js'), to: 'worker.min.js' },
  { from: path.join(coreDir, 'tesseract-core-simd-lstm.wasm.js'), to: 'tesseract-core-simd-lstm.wasm.js' },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const read = (file) => (existsSync(file) ? readFile(file) : null);
let problems = 0;

function noticeText() {
  return [
    'Third-party software served from this directory (on-device text recognition for /editor).',
    '',
    `worker.min.js                       tesseract.js ${tessVersion}, Apache-2.0, https://github.com/naptha/tesseract.js`,
    `tesseract-core-simd-lstm.wasm.js    tesseract.js-core ${coreVersion}, Apache-2.0, https://github.com/naptha/tesseract.js-core`,
    `eng.traineddata                     tessdata_fast 4.1.0, Apache-2.0, ${TRAINEDDATA.url}`,
    `                                    sha256 ${TRAINEDDATA.sha256}`,
    '',
    'Regenerate with: node scripts/copy-ocr-assets.mjs',
    '',
  ].join('\n');
}

async function writeIfChanged(name, data) {
  const target = path.join(outDir, name);
  const current = await read(target);
  if (current && sha256(current) === sha256(data)) return false;
  if (checkOnly) {
    console.error(`ocr assets: ${name} is missing or out of date`);
    problems++;
    return false;
  }
  const tmp = `${target}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
  console.log(`ocr assets: wrote ${name} (${(data.length / 1024 / 1024).toFixed(2)} MB)`);
  return true;
}

async function fetchTrainedData() {
  const res = await fetch(TRAINEDDATA.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${TRAINEDDATA.url}`);
  const data = Buffer.from(await res.arrayBuffer());
  const digest = sha256(data);
  if (digest !== TRAINEDDATA.sha256) {
    throw new Error(`eng.traineddata SHA-256 mismatch: expected ${TRAINEDDATA.sha256}, got ${digest}`);
  }
  return data;
}

if (!checkOnly) await mkdir(outDir, { recursive: true });

for (const { from, to } of COPIES) {
  await writeIfChanged(to, await readFile(from));
}

const trainedPath = path.join(outDir, 'eng.traineddata');
const trained = await read(trainedPath);
if (trained && sha256(trained) === TRAINEDDATA.sha256) {
  // already good
} else if (checkOnly) {
  console.error('ocr assets: eng.traineddata is missing or fails its SHA-256 check');
  problems++;
} else {
  try {
    await writeIfChanged('eng.traineddata', await fetchTrainedData());
  } catch (err) {
    await rm(`${trainedPath}.tmp`, { force: true });
    console.error(`ocr assets: could not download eng.traineddata: ${err instanceof Error ? err.message : err}`);
    console.error('            The editor still works; "Find text" will report that recognition is unavailable.');
    problems++;
  }
}

await writeIfChanged('NOTICE.txt', Buffer.from(noticeText()));

if (problems > 0) {
  process.exitCode = 1;
} else if (checkOnly) {
  console.log('ocr assets: ok');
}
