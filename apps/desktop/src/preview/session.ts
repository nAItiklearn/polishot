/**
 * The preview's editor session: the one `Editor` instance, how a capture's pixels get into it, and
 * the first-paint measurement. React-free so it can be reasoned about (and timed) on its own.
 */
import { Editor, PRESET_ORDER, type EditorDoc, type ImageSource, type PresetId } from '@polishot/editor';
import type { LookSettings, UserPreset } from '@polishot/editor/react';
import { captureUrl } from '../shared/ipc';

/* ------------------------------------------------------------------ */
/* Editor singleton                                                     */
/* ------------------------------------------------------------------ */

let instance: Editor | null = null;

/** The editor outlives React remounts: its canvas element is moved into whichever view shows it. */
export function getEditor(): Editor {
  if (!instance) instance = new Editor(document.createElement('div'), { licensed: false });
  return instance;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    instance?.destroy();
    instance = null;
  });
}

/* ------------------------------------------------------------------ */
/* Getting pixels into the editor                                       */
/* ------------------------------------------------------------------ */

export interface LoadedImage {
  source: ImageSource;
  /** Present when decoded off the main thread; the caller closes it once it is replaced. */
  bitmap: ImageBitmap | null;
  fetchMs: number;
  decodeMs: number;
}

async function decodeWithImageElement(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

/**
 * Fetches a capture from the custom protocol and decodes it. `fetch` + `createImageBitmap` keeps the
 * decode off the main thread, which is what makes the first paint fast; an `<img>` is the fallback if
 * the bitmap path is unavailable. Works with image/bmp (while the PNG is still being written) and
 * image/png, because the browser sniffs the bytes.
 */
export async function fetchCaptureImage(id: string): Promise<LoadedImage> {
  const url = captureUrl(id);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const t1 = performance.now();
    const bitmap = await createImageBitmap(blob);
    const t2 = performance.now();
    return {
      source: { id, width: bitmap.width, height: bitmap.height, element: bitmap },
      bitmap,
      fetchMs: t1 - t0,
      decodeMs: t2 - t1,
    };
  } catch {
    const t1 = performance.now();
    try {
      const img = await decodeWithImageElement(url);
      const t2 = performance.now();
      return {
        source: { id, width: img.naturalWidth, height: img.naturalHeight, element: img },
        bitmap: null,
        fetchMs: 0,
        decodeMs: t2 - t1,
      };
    } catch {
      throw new Error('That capture could not be loaded. It may have been removed.');
    }
  }
}

/* ------------------------------------------------------------------ */
/* First-paint measurement                                              */
/* ------------------------------------------------------------------ */

export interface PaintTiming {
  id: string;
  /** capture:ready received to the first frame with the canvas on screen. */
  totalMs: number;
  fetchMs: number;
  decodeMs: number;
  /** editor.load: analysis (auto-balance + background) + scene build + first draw. */
  editorMs: number;
  analyzeMs: number;
  /** After editor.load returns until the browser has presented the frame. */
  presentMs: number;
}

declare global {
  interface Window {
    /** Dev builds only: recent first-paint measurements, for tests and profiling. */
    __polishotTiming?: PaintTiming[];
  }
}

/** Resolves with a timestamp taken right after the next frame has been presented (or null if hidden). */
export function nextPresented(timeoutMs = 2000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), timeoutMs);
    requestAnimationFrame(() => {
      // A message-channel task runs after the frame the rAF callback belonged to has been painted.
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        window.clearTimeout(timer);
        ch.port1.close();
        resolve(performance.now());
      };
      ch.port2.postMessage(null);
    });
  });
}

/** Logs and records one measurement. Dev builds only; never includes image or text content. */
export function recordTiming(t: PaintTiming): void {
  if (!import.meta.env.DEV) return;
  (window.__polishotTiming ??= []).push(t);
  if (window.__polishotTiming.length > 20) window.__polishotTiming.shift();
  console.info(
    `[preview] capture:ready -> first paint ${t.totalMs.toFixed(0)} ms ` +
      `(fetch ${t.fetchMs.toFixed(0)}, decode ${t.decodeMs.toFixed(0)}, editor ${t.editorMs.toFixed(0)} ` +
      `of which analysis ${t.analyzeMs.toFixed(0)}, present ${t.presentMs.toFixed(0)})`,
  );
}

/* ------------------------------------------------------------------ */
/* Documents                                                            */
/* ------------------------------------------------------------------ */

/** Parses saved editor JSON; the editor validates it again in `load`. Null if it is not JSON. */
export function parseDoc(docJson: string | null | undefined): EditorDoc | undefined {
  if (!docJson) return undefined;
  try {
    return JSON.parse(docJson) as EditorDoc;
  } catch {
    return undefined;
  }
}

/** Applies a saved look to the open document as one undo step. */
export function applyLook(editor: Editor, s: LookSettings): void {
  editor.update({
    padding: s.padding,
    background: s.background,
    radius: s.radius,
    shadow: s.shadow,
    frame: s.frame,
    preset: s.preset,
    ...(s.custom ? { custom: s.custom } : {}),
  });
}

/**
 * Applies the "default preset" setting to a freshly loaded document: a saved look by id, or one of
 * the canvas size presets. "auto" (and anything unknown) leaves the auto-balanced result alone.
 */
export function applyDefaultPreset(editor: Editor, presetId: string, looks: readonly UserPreset[]): void {
  if (!presetId || presetId === 'auto' || presetId === 'custom') return;
  const look = looks.find((l) => l.id === presetId);
  if (look) {
    applyLook(editor, look.settings);
    return;
  }
  if ((PRESET_ORDER as readonly string[]).includes(presetId)) editor.update({ preset: presetId as PresetId });
}

/** The canvas size presets a user can pick as their default (built in, minus "custom"). */
export const DEFAULT_PRESET_CHOICES: readonly PresetId[] = PRESET_ORDER.filter((p) => p !== 'custom');
