/**
 * Renders the PNG that Copy would produce while the user is just looking at the capture, so Ctrl+C
 * can hand it over immediately (UX-BAR: copy under 300 ms, followed by a toast).
 *
 * The export render of a large capture (shadow, gradient, redaction blur) takes hundreds of
 * milliseconds, far more than the clipboard hand-off. Doing it once in the quiet moment after the
 * capture opens, and again after an edit settles, moves that cost out of the keypress. A cached image
 * is only used when the document, the licence and the brand mark are exactly what they were when it was
 * rendered, so a stale image can never be copied. A Copy that arrives while the render is running
 * joins it instead of starting a second one.
 */
import type { BrandMark, Editor } from '@polishot/editor';
import { useCallback, useEffect, useRef } from 'react';

/** Quiet time after the last change before rendering, so dragging a slider never competes with it. */
const IDLE_MS = 700;

function isTyping(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text');
}

export interface CopyPrewarm {
  /** The PNG of the current document: from the cache, from a render in progress, or rendered now. */
  get: () => Promise<Blob>;
  /** True when `get` would return immediately. */
  isReady: () => boolean;
}

export function useCopyPrewarm(editor: Editor, enabled: boolean, pro: boolean, brandMark: BrandMark | null): CopyPrewarm {
  const cache = useRef<{ key: string; blob: Blob } | null>(null);
  const inflight = useRef<{ key: string; promise: Promise<Blob> } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const keyNow = useCallback(
    () => `${pro ? 'pro' : 'free'}|${JSON.stringify(brandMark)}|${JSON.stringify(editor.doc)}`,
    [editor, pro, brandMark],
  );

  const get = useCallback((): Promise<Blob> => {
    const key = keyNow();
    if (cache.current?.key === key) return Promise.resolve(cache.current.blob);
    if (inflight.current?.key === key) return inflight.current.promise;
    const promise = editor.export({ format: 'png', quality: 1, scale: 1, licensed: pro }).then((blob) => {
      // Keep it only if nothing changed while it was rendering.
      if (keyNow() === key) cache.current = { key, blob };
      return blob;
    });
    const entry = { key, promise };
    inflight.current = entry;
    const done = () => {
      if (inflight.current === entry) inflight.current = null;
    };
    promise.then(done, done);
    return promise;
  }, [editor, pro, keyNow]);

  const isReady = useCallback(() => cache.current?.key === keyNow(), [keyNow]);

  useEffect(() => {
    if (!enabled) {
      cache.current = null;
      return;
    }
    const prepare = () => {
      if (!editor.hasImage || document.visibilityState === 'hidden') return;
      // Exporting commits an open text box; never do that behind the user's back.
      if (editor.tool === 'text' || isTyping(document.activeElement)) return;
      if (cache.current?.key === keyNow()) return;
      void get().catch(() => undefined);
    };
    const schedule = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(prepare, IDLE_MS);
    };
    schedule();
    const off = editor.on('change', schedule);
    return () => {
      off();
      window.clearTimeout(timer.current);
    };
  }, [editor, enabled, get, keyNow]);

  return { get, isReady };
}
