import type { OcrWord } from '@polishot/redact';
import type { BatchPayload, LoadPayload, NotifyPayload } from './payload';

/*
 * The Android <-> WebView bridge (docs/CONTRACTS.md section 6, plus the additions in docs/CONTRACT-CHANGES.md).
 *
 *  - Android -> page: `window.polishot` (installed by host.ts).
 *  - page -> Android: `window.PolishotAndroid`, a @JavascriptInterface object. Every argument is a string or a
 *    number; the native side validates all of them again.
 */

/** Methods the page exposes to Android. */
export interface PolishotApi {
  load(payload: unknown): void;
  setWords(words: unknown): void;
  setLicensed(licensed: boolean): void;
  /** Added: result of a save, copy, share or send. */
  notify(payload: unknown): void;
  /** Added: Android's back button. Returns true when the page used it (it closed a sheet). */
  onBack(): boolean;
  /** Added: batch beautify of several stored captures. */
  batch(payload: unknown): void;
}

/** Methods Android exposes to the page (the `PolishotAndroid` @JavascriptInterface object). */
export interface PolishotAndroidBridge {
  ready(): void;
  requestOcr(id: string): void;
  saveImage(base64: string, mime: string, filename: string): void;
  shareImage(base64: string, mime: string): void;
  copyImage(base64: string): void;
  copyText(text: string): void;
  saveDoc(id: string, docJson: string): void;
  quickSend(base64: string): void;
  close(): void;
  /** Added: progress of a batch run (done and failed are counts, total is the number of images). */
  batchProgress(done: number, total: number, failed: number): void;
}

declare global {
  interface Window {
    polishot?: PolishotApi;
    PolishotAndroid?: PolishotAndroidBridge;
  }
}

function bridge(): PolishotAndroidBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.PolishotAndroid;
}

/** Typed calls into Android. Outside the app (browser development) they are logged and ignored. */
export const native = {
  ready: () => bridge()?.ready(),
  requestOcr: (id: string) => bridge()?.requestOcr(id),
  saveImage: (base64: string, mime: string, filename: string) => bridge()?.saveImage(base64, mime, filename),
  shareImage: (base64: string, mime: string) => bridge()?.shareImage(base64, mime),
  copyImage: (base64: string) => bridge()?.copyImage(base64),
  copyText: (text: string) => bridge()?.copyText(text),
  saveDoc: (id: string, docJson: string) => bridge()?.saveDoc(id, docJson),
  quickSend: (base64: string) => bridge()?.quickSend(base64),
  close: () => bridge()?.close(),
  batchProgress: (done: number, total: number, failed: number) => bridge()?.batchProgress(done, total, failed),
  /** True inside the Android app. */
  get available(): boolean {
    return bridge() !== undefined;
  },
} as const;

/** What the page does with calls from Android. */
export interface HostHandlers {
  load(payload: LoadPayload): void;
  setWords(words: OcrWord[]): void;
  setLicensed(licensed: boolean): void;
  notify(payload: NotifyPayload): void;
  /** Return true when the back press was consumed. */
  onBack(): boolean;
  batch(payload: BatchPayload): void;
}
