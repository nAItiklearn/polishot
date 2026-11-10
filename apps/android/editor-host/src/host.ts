import type { OcrWord } from '@polishot/redact';
import type { HostHandlers, PolishotApi } from './native';
import {
  parseBatch,
  parseLoad,
  parseNotify,
  parseWords,
  type BatchPayload,
  type LoadPayload,
  type NotifyPayload,
} from './payload';

/*
 * Receives the calls from Android (`window.polishot.*`), validates them, and forwards them to the React app.
 * Android may call before React has mounted (the page tells it it is ready only after mounting, but a slow
 * device can still reorder things), so the latest value of each kind is held until the app attaches.
 */

interface Pending {
  load?: LoadPayload;
  words?: OcrWord[];
  licensed?: boolean;
  batch?: BatchPayload;
  notify: NotifyPayload[];
}

let handlers: HostHandlers | null = null;
const pending: Pending = { notify: [] };

function deliver(h: HostHandlers): void {
  const { load, words, licensed, batch, notify } = pending;
  pending.load = pending.words = pending.licensed = pending.batch = undefined;
  pending.notify = [];
  if (licensed !== undefined) h.setLicensed(licensed);
  if (load) h.load(load);
  if (words) h.setWords(words);
  if (batch) h.batch(batch);
  for (const n of notify) h.notify(n);
}

/** The origin images must come from; the page's own. */
const origin = (): string => window.location.origin;

/** Defines `window.polishot`. Call once, before the React app mounts. */
export function installPolishotApi(): void {
  const api: PolishotApi = {
    load(raw) {
      const payload = parseLoad(raw, origin());
      if (!payload) return;
      if (handlers) handlers.load(payload);
      else pending.load = payload;
    },
    setWords(raw) {
      const words = parseWords(raw);
      if (!words) return;
      if (handlers) handlers.setWords(words);
      else pending.words = words;
    },
    setLicensed(licensed) {
      if (typeof licensed !== 'boolean') return;
      if (handlers) handlers.setLicensed(licensed);
      else pending.licensed = licensed;
    },
    notify(raw) {
      const payload = parseNotify(raw);
      if (!payload) return;
      if (handlers) handlers.notify(payload);
      else pending.notify.push(payload);
    },
    onBack() {
      return handlers ? handlers.onBack() : false;
    },
    batch(raw) {
      const payload = parseBatch(raw, origin());
      if (!payload) return;
      if (handlers) handlers.batch(payload);
      else pending.batch = payload;
    },
  };
  window.polishot = api;
}

/** Connects the React app. Returns the function that disconnects it. */
export function attachHost(h: HostHandlers): () => void {
  handlers = h;
  deliver(h);
  return () => {
    if (handlers === h) handlers = null;
  };
}
