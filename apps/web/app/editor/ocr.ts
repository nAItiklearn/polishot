/**
 * On-device text recognition with tesseract.js. Everything is self-hosted from /ocr (see
 * scripts/copy-ocr-assets.mjs): the worker, the WebAssembly core and the English model. Nothing is fetched
 * from a CDN and the image never leaves the tab. The engine is imported only when recognition is asked
 * for, so it adds nothing to the first load.
 */
import type { OcrWord } from '@polishot/redact';
import type { Worker as TesseractWorker } from 'tesseract.js';

export type OcrStage = 'engine' | 'model' | 'read';

export interface OcrProgress {
  stage: OcrStage;
  /** 0..1 within the stage. */
  fraction: number;
}

export class OcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrError';
  }
}

const OCR_BASE = '/ocr';
const CORE_FILE = 'tesseract-core-simd-lstm.wasm.js';
/** The worker is freed after this long without a request: the WebAssembly heap is large. */
const IDLE_MS = 90_000;
/** Screenshot text is small. Tiny images are enlarged so glyphs are tall enough; huge ones are reduced. */
const MIN_LONG_SIDE = 1400;
const MAX_LONG_SIDE = 4000;
/** tesseract.js OEM.LSTM_ONLY. */
const OEM_LSTM_ONLY = 1;
/** Words the model is unsure about are noise in the selectable text layer. */
const MIN_CONFIDENCE = 30;

let workerPromise: Promise<TesseractWorker> | null = null;
let onProgress: ((p: OcrProgress) => void) | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let busy = false;

/** WebAssembly SIMD is required by the shipped core. Probe with a tiny module (v128.const + i8x16.popcnt). */
function supportsSimd(): boolean {
  try {
    // prettier-ignore
    const probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
    return typeof WebAssembly === 'object' && WebAssembly.validate(probe);
  } catch {
    return false;
  }
}

function report(stage: OcrStage, fraction: number): void {
  onProgress?.({ stage, fraction: Math.min(1, Math.max(0, fraction)) });
}

async function createWorker(): Promise<TesseractWorker> {
  if (!supportsSimd()) throw new OcrError('This browser cannot run text recognition (WebAssembly SIMD is missing).');
  const { createWorker: create, PSM } = await import('tesseract.js');
  const worker = await create(
    'eng',
    OEM_LSTM_ONLY,
    {
      workerPath: `${OCR_BASE}/worker.min.js`,
      corePath: `${OCR_BASE}/${CORE_FILE}`,
      langPath: OCR_BASE,
      gzip: false,
      // A plain same-origin worker: the CSP allows 'self' workers and no blob: script is needed.
      workerBlobURL: false,
      // The files are static assets, so the browser's HTTP cache already covers repeat visits.
      cacheMethod: 'none',
      logger: (m) => {
        if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') report('engine', m.progress);
        else if (m.status.includes('traineddata') || m.status === 'initializing api') report('model', m.progress);
        else if (m.status === 'recognizing text') report('read', m.progress);
      },
    },
    {},
  );
  await worker.setParameters({
    // SPARSE_TEXT finds loose text in UI screenshots better than page-layout analysis.
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: '1',
    // Screenshots carry no DPI. Without a value the engine guesses and logs "Estimating resolution" to the console.
    user_defined_dpi: '300',
  });
  return worker;
}

function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    const p = createWorker();
    workerPromise = p;
    p.catch(() => {
      if (workerPromise === p) workerPromise = null;
    });
  }
  return workerPromise;
}

/** Terminates the worker (if any). Safe to call at any time; the next recognition starts a fresh one. */
export function disposeOcr(): void {
  clearTimeout(idleTimer);
  const p = workerPromise;
  workerPromise = null;
  onProgress = null;
  busy = false;
  if (p) void p.then((w) => w.terminate()).catch(() => undefined);
}

function scheduleIdle(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!busy) disposeOcr();
  }, IDLE_MS);
}

/** Encodes the bitmap as PNG at `scale`, which is what the worker decodes. EXIF is already applied. */
async function encode(bitmap: ImageBitmap, scale: number): Promise<Blob> {
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new OcrError('This browser could not prepare the image for text recognition.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Flatten transparency onto white: the model is trained on dark text over light paper.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = canvas.height = 0;
  if (!blob) throw new OcrError('This browser could not prepare the image for text recognition.');
  return blob;
}

export function ocrScaleFor(width: number, height: number): number {
  const long = Math.max(width, height);
  if (long < MIN_LONG_SIDE) return 2;
  if (long > MAX_LONG_SIDE) return MAX_LONG_SIDE / long;
  return 1;
}

interface RawWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface RawLine {
  words?: RawWord[] | null;
}
interface RawBlocks {
  paragraphs?: { lines?: RawLine[] | null }[] | null;
}

/** Maps tesseract blocks to OcrWord[] in source-image pixels, numbering lines in reading order. */
export function wordsFromBlocks(blocks: readonly RawBlocks[] | null | undefined, scale: number): OcrWord[] {
  const out: OcrWord[] = [];
  let line = 0;
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const l of paragraph.lines ?? []) {
        let any = false;
        for (const w of l.words ?? []) {
          const text = w.text.trim();
          if (!text || w.confidence < MIN_CONFIDENCE) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          if (!(x1 > x0 && y1 > y0)) continue;
          out.push({
            text,
            line,
            box: { x: x0 / scale, y: y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale },
          });
          any = true;
        }
        if (any) line++;
      }
    }
  }
  return out;
}

/**
 * Recognises the text in a decoded image. Boxes come back in the bitmap's own pixel space, which is the
 * space the editor and `@polishot/redact` use.
 */
export async function recognize(bitmap: ImageBitmap, progress: (p: OcrProgress) => void): Promise<OcrWord[]> {
  if (busy) throw new OcrError('Text recognition is already running.');
  busy = true;
  clearTimeout(idleTimer);
  onProgress = progress;
  try {
    const scale = ocrScaleFor(bitmap.width, bitmap.height);
    const [worker, png] = await Promise.all([getWorker(), encode(bitmap, scale)]);
    report('read', 0);
    const { data } = await worker.recognize(png, {}, { blocks: true });
    return wordsFromBlocks(data.blocks, scale);
  } catch (err) {
    // A failed worker is not worth keeping; the next attempt starts clean.
    const p = workerPromise;
    workerPromise = null;
    if (p) void p.then((w) => w.terminate()).catch(() => undefined);
    if (err instanceof OcrError) throw err;
    throw new OcrError(
      'Text recognition could not start. Reload the page and try again.',
    );
  } finally {
    busy = false;
    onProgress = null;
    scheduleIdle();
  }
}
