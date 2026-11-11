/**
 * Renders the sample "captures" (samples/*.html) to PNG plus OCR-style word boxes.
 *
 *   node samples/render.ts [name ...]     writes samples/out/<name>.png and samples/out/<name>.json
 *
 * Why HTML: it gives real typography and layout, so the captures look like screenshots of real apps, and the
 * browser can tell us exactly where every word is. The word list plays the part of the OCR result in the
 * desktop mock (`ocr:ready`) and in the editor playground, so redaction and text selection work on the
 * sample exactly as they would after a real recognition pass.
 *
 * Word boxes are in image pixels (CSS px x scale) and follow the shape of `OcrWord` in @polishot/redact:
 * { text, line, box: { x, y, w, h } }. `line` groups words that sit on one visual row of one block, in
 * document order, like the lines a real OCR engine returns.
 */
import { chromium, type Browser } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLES_DIR = here;
export const SAMPLES_OUT = join(here, 'out');

/** Capture resolution: the sample is rendered at 2x so it looks like a screenshot from a hi-DPI laptop. */
export const SAMPLE_SCALE = 2;

export interface SampleDef {
  /** CSS size of the capture region. The PNG is `scale` (default SAMPLE_SCALE) times larger. */
  width: number;
  height: number;
  scale?: number;
}

export const SAMPLES = {
  settings: { width: 1200, height: 900 },
  editor: { width: 980, height: 744 },
  chat: { width: 1060, height: 720 },
  terminal: { width: 960, height: 620 },
  dashboard: { width: 1280, height: 800 },
  /** A phone screenshot (3x, like a real phone): the image the quick-send scene sends to the PC. */
  phone: { width: 390, height: 844, scale: 3 },
} as const satisfies Record<string, SampleDef>;

export type SampleName = keyof typeof SAMPLES;
export const SAMPLE_NAMES = Object.keys(SAMPLES) as SampleName[];

export interface OcrWordJson {
  text: string;
  line: number;
  box: { x: number; y: number; w: number; h: number };
}

export interface SampleMeta {
  name: SampleName;
  /** PNG size in image pixels. */
  width: number;
  height: number;
  scale: number;
  words: OcrWordJson[];
}

export const samplePng = (name: SampleName) => join(SAMPLES_OUT, `${name}.png`);
export const sampleJson = (name: SampleName) => join(SAMPLES_OUT, `${name}.json`);

/** Runs in the page: one box per visible word, in image pixels. */
function collectWords(scale: number): OcrWordJson[] {
  interface Piece {
    text: string;
    line: number;
    block: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
    /** The word ran to the very end of its text node (no space after it). */
    open: boolean;
  }
  const pieces: Piece[] = [];
  const blockIds = new WeakMap<Element, number>();
  let nextBlock = 0;
  const lineIds = new Map<string, number>();
  const blockOf = (start: Element | null): Element | null => {
    let el = start;
    while (el && el !== document.body) {
      const display = getComputedStyle(el).display;
      if (display !== 'inline' && display !== 'contents') return el;
      el = el.parentElement;
    }
    return el;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('[data-noocr], script, style, symbol')) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const block = blockOf(parent);
    if (!block) continue;
    if (!blockIds.has(block)) blockIds.set(block, nextBlock++);
    const blockId = blockIds.get(block)!;
    const text = node.nodeValue ?? '';
    const re = /\S+/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0);
      if (!rect) continue;
      if (rect.right < 0 || rect.bottom < 0 || rect.left > innerWidth || rect.top > innerHeight) continue;
      const key = `${blockId}:${Math.round((rect.top + rect.height / 2) / 6)}`;
      if (!lineIds.has(key)) lineIds.set(key, lineIds.size);
      const line = lineIds.get(key)!;
      const open = m.index + m[0].length === text.length;
      // Syntax highlighting and inline emphasis split one word over several text nodes ("error[E0382]" + ":").
      // An OCR engine would read them as a single word, so glue fragments that touch on the same line.
      const prev = pieces[pieces.length - 1];
      if (m.index === 0 && prev && prev.open && prev.block === blockId && prev.line === line && Math.abs(rect.left - prev.right) < 2) {
        prev.text += m[0];
        prev.right = rect.right;
        prev.top = Math.min(prev.top, rect.top);
        prev.bottom = Math.max(prev.bottom, rect.bottom);
        prev.open = open;
        continue;
      }
      pieces.push({ text: m[0], line, block: blockId, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, open });
    }
  }
  const round = (v: number) => Math.round(v * scale * 10) / 10;
  return pieces.map((p) => {
    // The DOM box is the font's full content area; OCR engines return something closer to the ink.
    const h = (p.bottom - p.top) * 0.9;
    return {
      text: p.text,
      line: p.line,
      box: { x: round(p.left), y: round(p.top + (p.bottom - p.top) * 0.05), w: round(p.right - p.left), h: round(h) },
    };
  });
}

export async function renderSample(browser: Browser, name: SampleName): Promise<SampleMeta> {
  const def: SampleDef = SAMPLES[name];
  const scale = def.scale ?? SAMPLE_SCALE;
  const context = await browser.newContext({
    viewport: { width: def.width, height: def.height },
    deviceScaleFactor: scale,
    colorScheme: 'light',
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(join(here, `${name}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const words = await page.evaluate(collectWords, scale);
    mkdirSync(SAMPLES_OUT, { recursive: true });
    await page.screenshot({ path: samplePng(name), type: 'png', animations: 'disabled', caret: 'hide' });
    const meta: SampleMeta = {
      name,
      width: def.width * scale,
      height: def.height * scale,
      scale,
      words,
    };
    writeFileSync(sampleJson(name), JSON.stringify(meta));
    return meta;
  } finally {
    await context.close();
  }
}

export async function renderSamples(names: readonly SampleName[] = SAMPLE_NAMES): Promise<SampleMeta[]> {
  const browser = await chromium.launch();
  try {
    const out: SampleMeta[] = [];
    for (const name of names) {
      const meta = await renderSample(browser, name);
      console.log(`  sample ${name.padEnd(10)} ${meta.width}x${meta.height}  ${meta.words.length} words`);
      out.push(meta);
    }
    return out;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wanted = process.argv.slice(2).filter((a): a is SampleName => a in SAMPLES);
  await renderSamples(wanted.length ? wanted : SAMPLE_NAMES);
}
