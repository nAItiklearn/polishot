/**
 * Owns "which capture is open": loads pixels into the editor when `capture:ready` arrives, tracks the
 * OCR words that follow, measures capture-to-first-paint, and saves the editor document back to
 * history when it has been edited.
 */
import type { Editor } from '@polishot/editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, events, ipc, type CaptureMeta, type OcrWord, type Settings } from '../../shared/ipc';
import { parseUserPresets } from '../lib/entitlement';
import { applyDefaultPreset, fetchCaptureImage, nextPresented, parseDoc, recordTiming } from '../session';
import type { Notify } from '../context';

export type CapturePhase = 'idle' | 'loading' | 'ready' | 'error';
export type OcrPhase = 'idle' | 'pending' | 'done' | 'failed';

export interface CaptureState {
  meta: CaptureMeta | null;
  phase: CapturePhase;
  error: string | null;
  /** Null until recognition has finished (an empty array means "no text found"). */
  words: OcrWord[] | null;
  ocr: OcrPhase;
}

const IDLE: CaptureState = { meta: null, phase: 'idle', error: null, words: null, ocr: 'idle' };
const AUTOSAVE_MS = 1500;
const WORD_CACHE = 6;

export interface LoadOptions {
  /** Saved editor document (re-opened from history). */
  docJson?: string | null;
  /** performance.now() when the triggering event arrived, for the first-paint measurement. */
  t0?: number;
}

export interface CaptureSession {
  state: CaptureState;
  load: (meta: CaptureMeta, opts?: LoadOptions) => Promise<void>;
  /** Writes the editor document to history now if it changed since it was loaded or last saved. */
  flush: () => Promise<void>;
  /** Re-runs recognition for the open capture (the "Find sensitive data" button). */
  rescan: () => Promise<void>;
}

export function useCaptureSession(editor: Editor, settings: Settings | null, notify: Notify): CaptureSession {
  const [state, setState] = useState<CaptureState>(IDLE);

  const token = useRef(0);
  const currentId = useRef<string | null>(null);
  const bitmap = useRef<ImageBitmap | null>(null);
  const savedJson = useRef('');
  const saveTimer = useRef<number | undefined>(undefined);
  const words = useRef(new Map<string, OcrWord[]>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const rememberWords = useCallback((id: string, list: OcrWord[]) => {
    words.current.delete(id);
    words.current.set(id, list);
    while (words.current.size > WORD_CACHE) {
      const oldest = words.current.keys().next().value;
      if (oldest === undefined) break;
      words.current.delete(oldest);
    }
  }, []);

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const id = currentId.current;
    if (!id || !editor.hasImage) return;
    const json = JSON.stringify(editor.doc);
    if (json === savedJson.current) return;
    savedJson.current = json;
    try {
      await ipc.historySave(id, json);
    } catch {
      // History is a convenience; a failed save must never interrupt editing. Retry on the next change.
      savedJson.current = '';
    }
  }, [editor]);

  const runOcr = useCallback(
    async (id: string) => {
      try {
        const list = await ipc.ocrRecognize(id);
        rememberWords(id, list);
        setState((s) => (s.meta?.id === id ? { ...s, words: list, ocr: 'done' } : s));
      } catch {
        setState((s) => (s.meta?.id === id && s.ocr === 'pending' ? { ...s, words: [], ocr: 'failed' } : s));
      }
    },
    [rememberWords],
  );

  const load = useCallback(
    async (meta: CaptureMeta, opts: LoadOptions = {}) => {
      const t0 = opts.t0 ?? performance.now();
      const mine = ++token.current;
      // Save the previous capture's edits without making the new one wait: flush() reads the document
      // synchronously, before editor.load replaces it.
      void flush();
      const cached = words.current.get(meta.id) ?? null;
      setState({ meta, phase: 'loading', error: null, words: cached, ocr: cached ? 'done' : 'pending' });
      try {
        const img = await fetchCaptureImage(meta.id);
        if (mine !== token.current) {
          img.bitmap?.close();
          return; // a newer capture arrived while this one was decoding
        }
        const tEditor = performance.now();
        const doc = parseDoc(opts.docJson);
        editor.load(img.source, doc);
        const editorMs = performance.now() - tEditor;
        if (!doc) {
          const s = settingsRef.current;
          if (s) applyDefaultPreset(editor, s.defaultPreset, parseUserPresets(s.userPresets));
        }
        // The previous bitmap is only released once the editor no longer draws from it.
        bitmap.current?.close();
        bitmap.current = img.bitmap;
        currentId.current = meta.id;
        savedJson.current = JSON.stringify(editor.doc);
        setState((s) => (s.meta?.id === meta.id ? { ...s, phase: 'ready' } : s));

        void nextPresented().then((presented) => {
          if (presented === null) return;
          recordTiming({
            id: meta.id,
            totalMs: presented - t0,
            fetchMs: img.fetchMs,
            decodeMs: img.decodeMs,
            editorMs,
            analyzeMs: editor.timings.analyzeMs ?? 0,
            presentMs: presented - (tEditor + editorMs),
          });
        });

        if (!cached) void runOcr(meta.id);
      } catch (e) {
        if (mine !== token.current) return;
        const message = errorMessage(e);
        setState({ meta, phase: 'error', error: message, words: null, ocr: 'idle' });
        notifyRef.current({ message, tone: 'error' });
      }
    },
    [editor, flush, runOcr],
  );

  const rescan = useCallback(async () => {
    const id = currentId.current;
    if (!id) return;
    setState((s) => (s.meta?.id === id ? { ...s, ocr: 'pending' } : s));
    await runOcr(id);
  }, [runOcr]);

  // The styled image is in the document and its first frame is drawn (editor.load draws synchronously, and the
  // phase only becomes 'ready' once React has committed it): the backend may show the window now. Not tied to
  // requestAnimationFrame, which does not run while the window is still hidden. A load that failed announces too,
  // so a window that waits to be told is never left waiting for an image that is not coming; it shows the error.
  // An older backend has no such command and the rejection is ignored.
  const announcedFor = state.phase === 'ready' || state.phase === 'error' ? (state.meta?.id ?? null) : null;
  useEffect(() => {
    if (announcedFor) ipc.previewReady(announcedFor).catch(() => undefined);
  }, [announcedFor]);

  // capture:ready and ocr:ready come from Rust.
  useEffect(() => {
    const offReady = events.onCaptureReady((meta) => {
      void load(meta, { t0: performance.now() });
    });
    const offOcr = events.onOcrReady(({ id, words: list }) => {
      rememberWords(id, list);
      setState((s) => (s.meta?.id === id ? { ...s, words: list, ocr: 'done' } : s));
    });
    return () => {
      offReady();
      offOcr();
    };
  }, [load, rememberWords]);

  // Autosave the editor document shortly after edits, and whenever the window goes away.
  useEffect(() => {
    const schedule = () => {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    };
    const offChange = editor.on('change', schedule);
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      offChange();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      window.clearTimeout(saveTimer.current);
    };
  }, [editor, flush]);

  return { state, load, flush, rescan };
}
