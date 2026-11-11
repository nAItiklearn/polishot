#!/usr/bin/env node
/**
 * Records the website's in-browser editor flow as a video: home page -> web editor -> open a screenshot
 * (auto-balanced on open) -> find sensitive data (on-device OCR) -> blur it -> copy all text -> export a PNG.
 *
 * Runs locally and headless. Uses the Playwright that apps/web already pins (@playwright/test 1.65.0, whose
 * `page.screencast` API draws the pointer and records the video), so there is nothing extra to install.
 *
 *   node tools/demo/web-flow-demo.mjs --start-server          # starts `next dev -p 3100` itself, records, stops it
 *   node tools/demo/web-flow-demo.mjs --start-server --prod   # builds and starts the production site instead: no dev badge
 *                                                             #   in the corner, steadier while other people edit the code
 *   node tools/demo/web-flow-demo.mjs                         # a dev server is already on http://127.0.0.1:3100
 *   node tools/demo/web-flow-demo.mjs --url https://polishot.example   # any deployed copy
 *   node tools/demo/web-flow-demo.mjs --sample-only           # just render assets/sample.html to a PNG
 *
 * Output (gitignored): tools/demo/out/web/
 *   polishot-web-flow.mp4    H.264, when ffmpeg is on PATH (otherwise only the .webm is written)
 *   polishot-web-flow.webm   the raw recording (kept when ffmpeg is missing or with --keep-webm)
 *   sample-billing.png       the screenshot that was opened in the editor (2560x1600)
 *   exported.png             the file the editor's Download button produced
 *   run.json                 timeline, versions and the checks that were made
 *
 * Exit codes: 0 done, 1 failed, 2 recorded but a check failed (the video may not show what it should).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WEB = path.join(REPO, 'apps', 'web');
const SAMPLE_HTML = path.join(HERE, 'assets', 'sample.html');

/** The Playwright that apps/web pins. The screencast API used below arrived in 1.59. */
const PLAYWRIGHT_PINNED = '1.65.0';
const DEFAULT_URL = 'http://127.0.0.1:3100';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    'start-server': { type: 'boolean', default: false },
    prod: { type: 'boolean', default: false },
    out: { type: 'string' },
    headed: { type: 'boolean', default: false },
    width: { type: 'string', default: '1440' },
    height: { type: 'string', default: '900' },
    pace: { type: 'string', default: '1' },
    'ocr-timeout': { type: 'string', default: '240' },
    'no-captions': { type: 'boolean', default: false },
    'no-mp4': { type: 'boolean', default: false },
    'no-speedup': { type: 'boolean', default: false },
    'keep-webm': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    'sample-only': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?|^ \* ?/gm, ''));
  process.exit(0);
}

const BASE_URL = (args.url ?? process.env.DEMO_URL ?? DEFAULT_URL).replace(/\/+$/, '');
const OUT = path.resolve(args.out ?? path.join(HERE, 'out', 'web'));
const WIDTH = positiveInt(args.width, 'width');
const HEIGHT = positiveInt(args.height, 'height');
const PACE = Number(args.pace);
if (!(PACE > 0 && PACE <= 5)) fail('--pace must be a number above 0 and at most 5 (1 is normal speed, 2 is twice as slow).');
const OCR_TIMEOUT_MS = positiveInt(args['ocr-timeout'], 'ocr-timeout') * 1000;
const CAPTIONS = !args['no-captions'];

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(`--${name} must be a positive whole number (got "${value}").`);
  return n;
}

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

const log = (msg) => console.log(`[web-demo] ${msg}`);

// ---------------------------------------------------------------------------------------------- Playwright

const requireFromWeb = createRequire(path.join(WEB, 'package.json'));

function loadPlaywright() {
  let pkgPath;
  try {
    pkgPath = requireFromWeb.resolve('@playwright/test/package.json');
  } catch {
    fail(
      `Could not find @playwright/test in ${path.join(WEB, 'node_modules')}.\n` +
        `Run "pnpm install" at the repository root (${REPO}), then try again.`,
    );
  }
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  if (version !== PLAYWRIGHT_PINNED) {
    log(`warning: expected @playwright/test ${PLAYWRIGHT_PINNED}, found ${version}. The screencast API needs 1.59 or newer.`);
  }
  const pw = requireFromWeb('@playwright/test');
  if (!pw.chromium) fail('@playwright/test did not export "chromium"; check the Playwright install.');
  return { chromium: pw.chromium, version };
}

// ---------------------------------------------------------------------------------------------- the subject

/** Renders assets/sample.html to a 2560x1600 PNG: the same "screenshot" the Windows and Android demos use. */
async function renderSample(chromium, outPng) {
  if (!existsSync(SAMPLE_HTML)) fail(`Missing ${SAMPLE_HTML}.`);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(pathToFileURL(SAMPLE_HTML).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: outPng, type: 'png' });
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------------------------- dev server

async function isUp(url) {
  try {
    const res = await fetch(`${url}/editor`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/** Runs the Next CLI from apps/web. Returns the child and a way to read the tail of its output. */
function spawnNext(nextBin, argv, distDir) {
  const child = spawn(process.execPath, [nextBin, ...argv], {
    cwd: WEB,
    env: { ...process.env, NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let tail = '';
  const keep = (chunk) => {
    tail = (tail + chunk.toString()).slice(-4000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const done = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, done, tail: () => tail };
}

/**
 * Starts apps/web when nothing answers on BASE_URL: `next dev` by default, or with --prod a production build and
 * `next start`. Both use their own build folder (.next-demo, .next-demo-prod), so a dev server of your own is left alone.
 * Returns a stop() function.
 */
async function ensureServer() {
  if (await isUp(BASE_URL)) {
    log(`using the server already running at ${BASE_URL}`);
    return { stop() {} };
  }
  const hint = `cd apps/web && npx next dev -p 3100   (or pass --start-server to let this script do it)`;
  if (!args['start-server']) fail(`Nothing is answering at ${BASE_URL}/editor.
Start the website first:
  ${hint}`);

  const target = new URL(BASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(target.hostname)) {
    fail(`--start-server only starts a local server, but --url points at ${target.hostname}.`);
  }
  let nextBin;
  try {
    nextBin = requireFromWeb.resolve('next/dist/bin/next');
  } catch {
    fail(`Could not find "next" in ${WEB}. Run "pnpm install" at the repository root first.`);
  }
  const port = target.port || '3100';
  const distDir = args.prod ? '.next-demo-prod' : '.next-demo';

  if (args.prod) {
    log('building the production site (a few minutes the first time)');
    const build = spawnNext(nextBin, ['build'], distDir);
    const timeout = setTimeout(() => killTree(build.child), 20 * 60_000);
    const code = await build.done;
    clearTimeout(timeout);
    if (code !== 0) fail(`next build failed (exit ${code}). Last output:
${build.tail()}`);
  }

  log(`starting next ${args.prod ? 'start' : 'dev'} on port ${port} (build folder ${distDir})`);
  const server = spawnNext(nextBin, args.prod ? ['start', '-p', port] : ['dev', '-p', port], distDir);
  let exited = false;
  server.child.on('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (exited) fail(`next exited early. Last output:
${server.tail()}`);
    if (await isUp(BASE_URL)) {
      // Compile the pages the demo visits now (dev only), so the recording does not show a build.
      await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(120_000) }).catch(() => undefined);
      log('server is ready');
      return { stop: () => killTree(server.child) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  killTree(server.child);
  fail(`next did not answer within 3 minutes. Last output:
${server.tail()}`);
}

// ---------------------------------------------------------------------------------------------- recording

const captionHtml = (text) => `
  <div style="position:fixed;left:50%;bottom:30px;transform:translateX(-50%);max-width:80%;
              padding:11px 20px;border-radius:999px;background:rgba(12,12,11,.82);
              border:1px solid rgba(255,255,255,.12);color:#f4f2ee;
              font:500 19px/1.25 'Segoe UI',system-ui,-apple-system,Arial,sans-serif;letter-spacing:.005em;
              box-shadow:0 8px 30px rgba(0,0,0,.35);white-space:nowrap">${text}</div>`;

async function recordFlow({ chromium, samplePng }) {
  const checks = [];
  const marks = {};
  const waits = [];
  const problems = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  };

  const rawWebm = path.join(OUT, 'polishot-web-flow.webm');
  rmSync(rawWebm, { force: true });

  const browser = await chromium.launch({
    headless: !args.headed,
    // Headless Chromium has no GPU; its software renderer lets the site's WebGL backgrounds draw (as in the e2e config).
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  let startedAt = 0;
  let pageRef = null;
  const t = () => (Date.now() - startedAt) / 1000;
  const beat = (ms) => new Promise((r) => setTimeout(r, ms * PACE));

  try {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      acceptDownloads: true,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    context.setDefaultTimeout(30_000);
    const page = await context.newPage();
    pageRef = page;
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      // The dev server logs a few harmless hot-reload and devtools lines; only real errors matter.
      if (m.type() === 'error' && !/Download the React DevTools|favicon/i.test(m.text())) problems.push(`console.error: ${m.text()}`);
    });
    if (typeof page.screencast?.start !== 'function') {
      fail('This Playwright has no page.screencast API (needs 1.59 or newer). Run "pnpm install" at the repository root.');
    }

    await page.screencast.start({ path: rawWebm, size: { width: WIDTH, height: HEIGHT }, quality: 90 });
    startedAt = Date.now();
    await page.screencast.showActions({
      cursor: 'pointer',
      duration: 900,
      position: 'top-right',
      style: {
        point: 'width:26px;height:26px;border-radius:50%;background:rgba(228,87,46,.35);border:2px solid #e4572e',
        highlight: 'outline:2px solid rgba(228,87,46,.9);outline-offset:3px;border-radius:8px',
        // The action title ("Click", "Fill") is noise next to our own captions.
        title: 'display:none',
      },
    });
    // One caption at a time. With `ms` it removes itself after that long; without, it stays until disposed (so it can
    // span a sped-up wait). showOverlay() would block for its whole `duration`, so the timer is ours.
    let current = null;
    const caption = async (text, ms) => {
      if (!CAPTIONS) return { dispose: async () => undefined };
      await current?.dispose().catch(() => undefined);
      const handle = await page.screencast.showOverlay(captionHtml(text));
      current = handle;
      if (ms) {
        const timer = setTimeout(() => {
          handle.dispose().catch(() => undefined);
          if (current === handle) current = null;
        }, ms * PACE);
        timer.unref?.();
      }
      return handle;
    };
    // A stretch of waiting that is played faster in the finished video (page loads, text recognition, export rendering).

    const waiting = async (name, fn) => {
      const from = t();
      const result = await fn();
      waits.push({ name, from, to: t() });
      if (args.verbose) log(`${from.toFixed(1)}s ${name} took ${(t() - from).toFixed(1)}s`);
      return result;
    };

    // 1. Home page, then the editor.
    //    The editor is opened with a full page load on purpose, not by clicking the "Web editor" link: a client-side
    //    navigation keeps the CSP of the page it came from (worker-src 'none'), which blocks the OCR worker, so
    //    "Find sensitive data" fails with "Text recognition could not start". See the notes in tools/demo/README.md.
    marks.start = t();
    await page.goto('/', { waitUntil: 'load' });
    marks.home = t();
    await caption('Polishot has a free editor in the browser.', 2600);
    await beat(2400);
    await waiting('page load', async () => {
      await page.goto('/editor', { waitUntil: 'load' });
      await page.getByRole('button', { name: 'Choose image' }).waitFor();
    });

    // 2. Empty state, then a screenshot goes in through the real file chooser.
    await caption('Drop in a screenshot. Nothing is uploaded.', 2600);
    await beat(2000);
    marks.open = t();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Choose image' }).click(),
    ]);
    const studio = page.getByTestId('editor-studio');
    await waiting('opening the image', async () => {
      await chooser.setFiles(samplePng);
      await studio.waitFor();
      await page.locator('.pe-root canvas').first().waitFor();
    });
    marks.studio = t();
    check('the editor opened the screenshot', true, await page.locator('.ed-file-dims').innerText());
    const padding = Number(await studio.getAttribute('data-padding'));
    check('auto-balance was applied on open', padding > 0, `padding ${padding}`);
    await caption('Auto-balanced and styled the moment it opens.', 3000);
    await beat(3200);

    // 3. Find sensitive data. Opening the Redact tab starts text recognition on this device (the "Find sensitive
    //    data" button only shows if it did not start by itself). The wait is real; the video plays it faster.
    await page.getByRole('tab', { name: 'Redact' }).click();
    marks.ocrStart = t();
    const scanning = await caption('Looking for emails, cards and IP addresses, on this device.');
    await beat(700);
    const findButton = page.getByRole('button', { name: 'Find sensitive data' });
    if (await findButton.isVisible().catch(() => false)) await findButton.click();
    const rows = page.getByRole('switch');
    try {
      await rows.first().waitFor({ timeout: OCR_TIMEOUT_MS });
    } catch {
      const stillRunning = await page.getByTestId('ocr-progress').isVisible().catch(() => false);
      throw new Error(
        stillRunning
          ? `Text recognition was still running after ${OCR_TIMEOUT_MS / 1000} s. Raise --ocr-timeout.`
          : 'No sensitive data was found in the screenshot. Check tools/demo/assets/sample.html and the OCR files in apps/web/public/ocr.',
      );
    }
    marks.ocrEnd = t();
    waits.push({ name: 'text recognition', from: marks.ocrStart + 1.8, to: marks.ocrEnd - 0.8 });
    await scanning.dispose();
    const found = await rows.count();
    check('sensitive data was found', found >= 3, `${found} items (expect email, card, IP)`);
    await beat(1800);

    // 4. One click hides everything.
    await caption('One click hides it all.', 2600);
    await page.getByRole('button', { name: 'Blur all' }).click();
    await page.getByText(`${found} of ${found} hidden`).waitFor();
    marks.blurred = t();
    check('everything was blurred', Number(await studio.getAttribute('data-annotations')) === found);
    await beat(2600);

    // 5. Copy all text.
    await page.getByRole('tab', { name: 'Text' }).click();
    await beat(700);
    await caption('Copy every word in one click.', 2800);
    await page.getByRole('button', { name: 'Copy all text' }).click();
    await page.getByRole('button', { name: 'Copied' }).waitFor();
    marks.copied = t();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check('the recognised text is on the clipboard', /alex\.morgan@example\.com/i.test(clipboard), `${clipboard.length} characters`);
    await beat(2400);

    // 6. Export.
    await page.getByRole('tab', { name: 'Export' }).click();
    await beat(700);
    await caption('Export a clean PNG.', 2800);
    const exported = path.join(OUT, 'exported.png');
    const download = await waiting('rendering the export', async () => {
      const [d] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('tabpanel', { name: 'Export' }).getByRole('button', { name: 'Download' }).click(),
      ]);
      await d.saveAs(exported);
      return d;
    });
    marks.exported = t();
    check('a PNG was exported', download.suggestedFilename().endsWith('.png'), download.suggestedFilename());
    await beat(2600);
    marks.end = t();

    check('the page raised no errors', problems.length === 0, problems.slice(0, 3).join(' | '));
    await page.screencast.stop();
    await context.close();
  } catch (err) {
    // Leave something to look at: the last frame and what the page was saying.
    if (pageRef && !pageRef.isClosed()) {
      await pageRef.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => undefined);
      log(`the last frame was saved to ${path.join(OUT, 'failure.png')}`);
    }
    throw err;
  } finally {
    await browser.close();
  }
  return { checks, marks, waits, problems, rawWebm };
}

// ---------------------------------------------------------------------------------------------- ffmpeg

function haveFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function durationOf(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
    encoding: 'utf8',
  });
  const d = Number.parseFloat(r.stdout);
  return Number.isFinite(d) ? d : null;
}

/** Waits shorter than this are left alone; longer ones are played faster (see SPEED_UP). */
const SPEED_UP_MIN_SECONDS = 2.5;
const SPEED_UP = { 'text recognition': 6, 'page load': 8, 'opening the image': 4, 'rendering the export': 6 };

/** Re-encodes to H.264. Stretches of waiting are played faster so the finished video stays brisk. */
function toMp4(rawWebm, waits) {
  const mp4 = path.join(OUT, 'polishot-web-flow.mp4');
  const spans = args['no-speedup']
    ? []
    : waits
        .filter((w) => Number.isFinite(w.from) && Number.isFinite(w.to) && w.to - w.from >= SPEED_UP_MIN_SECONDS)
        .sort((x, y) => x.from - y.from)
        .map((w) => ({ ...w, factor: SPEED_UP[w.name] ?? 6 }));

  const ffArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-i', rawWebm];
  if (spans.length > 0) {
    const f = (n) => n.toFixed(3);
    const parts = [];
    let cursor = 0;
    for (const w of spans) {
      if (w.from > cursor) parts.push({ from: cursor, to: w.from, factor: 1 });
      parts.push({ from: Math.max(w.from, cursor), to: w.to, factor: w.factor });
      cursor = w.to;
    }
    parts.push({ from: cursor, to: null, factor: 1 });
    // Each trimmed part needs its own copy of the input stream.
    const outs = parts.map((_, i) => `[s${i}]`).join('');
    const chains = parts.map((p, i) => {
      const range = p.to === null ? `start=${f(p.from)}` : `start=${f(p.from)}:end=${f(p.to)}`;
      return `[s${i}]trim=${range},setpts=(PTS-STARTPTS)/${p.factor}[p${i}]`;
    });
    const filter =
      `[0:v]split=${parts.length}${outs};` +
      chains.join(';') +
      `;${parts.map((_, i) => `[p${i}]`).join('')}concat=n=${parts.length}:v=1:a=0,fps=30,format=yuv420p[v]`;
    ffArgs.push('-filter_complex', filter, '-map', '[v]');
    for (const w of spans) log(`playing "${w.name}" ${w.factor}x faster (${f(w.from)}s to ${f(w.to)}s)`);
  } else {
    ffArgs.push('-vf', 'fps=30,format=yuv420p');
  }
  ffArgs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', '-an', mp4);
  const r = spawnSync('ffmpeg', ffArgs, { encoding: 'utf8' });
  if (r.status !== 0) {
    log(`ffmpeg failed (${r.status}): ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
    return null;
  }
  return { mp4, speedUps: spans.map(({ name, from, to, factor }) => ({ name, from, to, factor })) };
}

// ---------------------------------------------------------------------------------------------- main

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium, version } = loadPlaywright();
  const samplePng = path.join(OUT, 'sample-billing.png');

  log(`rendering the sample screenshot to ${samplePng}`);
  await renderSample(chromium, samplePng);
  if (args['sample-only']) {
    log('done (--sample-only)');
    return 0;
  }

  const server = await ensureServer();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.stop();
  };
  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });

  let result;
  try {
    result = await recordFlow({ chromium, samplePng });
  } finally {
    stop();
  }

  let finalVideo = result.rawWebm;
  let sped = [];
  if (!existsSync(result.rawWebm) || statSync(result.rawWebm).size < 10_000) {
    fail('Playwright did not write a video. Run again with --headed to watch what happens.');
  }
  if (!args['no-mp4']) {
    if (haveFfmpeg()) {
      const encoded = toMp4(result.rawWebm, result.waits);
      if (encoded) {
        finalVideo = encoded.mp4;
        sped = encoded.speedUps;
        if (!args['keep-webm']) rmSync(result.rawWebm, { force: true });
      }
    } else {
      log('ffmpeg is not on PATH, so only the .webm was written (install ffmpeg for an .mp4).');
    }
  }

  const seconds = durationOf(finalVideo);
  const summary = {
    video: finalVideo,
    seconds,
    speedUps: sped,
    playwright: version,
    baseUrl: BASE_URL,
    viewport: { width: WIDTH, height: HEIGHT },
    timelineSeconds: result.marks,
    checks: result.checks,
    problems: result.problems,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const failed = result.checks.filter((c) => !c.ok);
  log(`video: ${finalVideo}${seconds ? ` (${seconds.toFixed(1)} s)` : ''}`);
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed: ${failed.map((c) => c.name).join('; ')}`);
    return 2;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\nERROR: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
