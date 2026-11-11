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
 *
 * The render runs on the main thread and cannot be interrupted, so it must never start while the user is working:
 * a render that begins half a second after a slider drag would eat the first frames of the next one. It waits for a
 * quiet spell with no pointer, key or wheel activity, never starts with a button held or input pending
 * (`navigator.scheduling.isInputPending`, where the webview has it), and then runs in an idle callback. If the user
 * is faster than all that, Copy renders on demand, as it did before this existed.
 */
import type { BrandMark, Editor } from '@polishot/editor';
import { useCallback, useEffect, useRef } from 'react';

/** Quiet time after the last change before rendering, so dragging a slider never competes with it. */
const IDLE_MS = 700;
/** How long without pointer, key or wheel activity counts as "the user has stopped". */
export const QUIET_MS = 1200;

export interface InputActivity {
  now: number;
  /** performance.now() of the last pointer, key or wheel event. */
  lastInput: number;
  /** A pointer button is held (a drag is under way). */
  pointerDown: boolean;
  /** The browser says input is waiting to be handled. */
  inputPending: boolean;
}

/**
 * How long to hold off before rendering: 0 means the user has been still long enough. A held button or pending
 * input defers shortly and is asked again; recent activity defers until the quiet spell is complete.
 */
export function copyPrewarmDelay(a: InputActivity, quietMs: number = QUIET_MS): number {
  if (a.pointerDown) return 400;
  if (a.inputPending) return 120;
  const remaining = quietMs - (a.now - a.lastInput);
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

type SchedulingNavigator = Navigator & { scheduling?: { isInputPending?: (options?: { includeContinuous?: boolean }) => boolean } };

function inputPending(): boolean {
  try {
    return (navigator as SchedulingNavigator).scheduling?.isInputPending?.({ includeContinuous: true }) === true;
  } catch {
    return false;
  }
}

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
  const idle = useRef<number | undefined>(undefined);
  const lastInput = useRef(Number.NEGATIVE_INFINITY);
  const pointerDown = useRef(false);

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
    // What the user is doing, from capture-phase passive listeners (they cost nothing and never get in the way).
    const touch = () => {
      lastInput.current = performance.now();
    };
    const down = () => {
      pointerDown.current = true;
      touch();
    };
    const up = () => {
      pointerDown.current = false;
      touch();
    };
    const listen = { capture: true, passive: true } as const;
    const events: Array<[string, () => void]> = [
      ['pointerdown', down],
      ['pointerup', up],
      ['pointercancel', up],
      ['pointermove', touch],
      ['keydown', touch],
      ['wheel', touch],
    ];
    events.forEach(([name, fn]) => window.addEventListener(name, fn, listen));

    const delayNow = () =>
      copyPrewarmDelay({ now: performance.now(), lastInput: lastInput.current, pointerDown: pointerDown.current, inputPending: inputPending() });

    const schedule = (ms: number = IDLE_MS) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(prepare, ms);
    };

    const render = () => {
      // Checked once more at the last moment: input may have started while this was waiting for an idle slot.
      const wait = delayNow();
      if (wait > 0) {
        schedule(wait);
        return;
      }
      if (cache.current?.key !== keyNow()) void get().catch(() => undefined);
    };

    function prepare() {
      if (!editor.hasImage || document.visibilityState === 'hidden') return;
      // Exporting commits an open text box; never do that behind the user's back.
      if (editor.tool === 'text' || isTyping(document.activeElement)) return;
      if (cache.current?.key === keyNow()) return;
      const wait = delayNow();
      if (wait > 0) {
        schedule(wait);
        return;
      }
      // An idle slot, when the webview offers them; a Copy that comes first simply renders on demand.
      if (typeof window.requestIdleCallback === 'function') {
        window.cancelIdleCallback(idle.current ?? 0);
        idle.current = window.requestIdleCallback(render, { timeout: 4000 });
      } else {
        render();
      }
    }

    schedule();
    const onChange = () => schedule();
    const off = editor.on('change', onChange);
    return () => {
      off();
      events.forEach(([name, fn]) => window.removeEventListener(name, fn, listen));
      pointerDown.current = false;
      window.clearTimeout(timer.current);
      if (idle.current !== undefined && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle.current);
    };
  }, [editor, enabled, get, keyNow]);

  return { get, isReady };
}
