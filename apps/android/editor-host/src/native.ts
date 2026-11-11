import type { OcrWord } from '@polishot/redact';
import { blobToBase64 } from './base64';
import { binaryMessage, textMessage, type ImageMethod } from './messages';
import type { BatchPayload, LoadPayload, NotifyPayload } from './payload';

/*
 * The Android <-> WebView bridge (docs/CONTRACTS.md section 6, plus the additions in docs/CONTRACT-CHANGES.md).
 *
 *  - Android -> page: `window.polishot` (installed by host.ts).
 *  - page -> Android, preferred: `window.PolishotNative.postMessage(...)`, a web message listener that Android only
 *    exposes to this page's own origin. Calls are JSON text; images go as an ArrayBuffer when Android says it can
 *    take one (`binaryImages` in the load payload), otherwise as base64 inside the JSON.
 *  - page -> Android, fallback for a WebView too old for that: `window.PolishotAndroid`, a @JavascriptInterface
 *    object with one method per call. Every argument is a string or a number.
 *
 * The native side validates every argument again, whichever way it arrived.
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
  /** Added: write a pending document edit now (the screen is about to be paused). */
  flush(): void;
}

/** The message channel Android installs for this page's origin. */
export interface PolishotNativePort {
  postMessage(message: string | ArrayBuffer): void;
}

/** Methods Android exposes to the page through the legacy `PolishotAndroid` @JavascriptInterface object. */
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
    PolishotNative?: PolishotNativePort;
  }
}

function legacy(): PolishotAndroidBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.PolishotAndroid;
}

function port(): PolishotNativePort | undefined {
  return typeof window === 'undefined' ? undefined : window.PolishotNative;
}

/** Whether Android announced that it takes images as an ArrayBuffer. Set from the load and batch payloads. */
let binaryImages = false;

export function setBinaryImages(value: boolean): void {
  binaryImages = value;
}

/** One call, over whichever channel Android gave this page. */
function call(method: string, fields: Record<string, unknown>, viaInterface: (b: PolishotAndroidBridge) => void): void {
  const p = port();
  if (p) {
    p.postMessage(textMessage(method, fields));
    return;
  }
  const b = legacy();
  if (b) viaInterface(b);
}

/** An image call. Binary when allowed (no base64, no 33% growth, no string of tens of megabytes), base64 otherwise. */
async function sendImage(
  method: ImageMethod,
  image: Blob,
  mime: string,
  filename: string | undefined,
  viaInterface: (b: PolishotAndroidBridge, base64: string) => void,
): Promise<void> {
  const p = port();
  if (p && binaryImages) {
    p.postMessage(await binaryMessage(method, image, mime, filename));
    return;
  }
  const base64 = await blobToBase64(image);
  if (p) {
    p.postMessage(textMessage(method, { base64, mime, ...(filename ? { filename } : {}) }));
    return;
  }
  const b = legacy();
  if (b) viaInterface(b, base64);
}

/** Typed calls into Android. Outside the app (browser development) they are ignored. */
export const native = {
  ready: () => call('ready', {}, (b) => b.ready()),
  requestOcr: (id: string) => call('requestOcr', { id }, (b) => b.requestOcr(id)),
  /** Images are Blobs; the transport decides how to carry them. Resolves once the call has been handed to Android. */
  saveImage: (image: Blob, mime: string, filename: string) =>
    sendImage('saveImage', image, mime, filename, (b, base64) => b.saveImage(base64, mime, filename)),
  shareImage: (image: Blob, mime: string) =>
    sendImage('shareImage', image, mime, undefined, (b, base64) => b.shareImage(base64, mime)),
  /** Copy is always PNG. */
  copyImage: (image: Blob) => sendImage('copyImage', image, 'image/png', undefined, (b, base64) => b.copyImage(base64)),
  copyText: (text: string) => call('copyText', { text }, (b) => b.copyText(text)),
  saveDoc: (id: string, docJson: string) => call('saveDoc', { id, doc: docJson }, (b) => b.saveDoc(id, docJson)),
  quickSend: (image: Blob) => sendImage('quickSend', image, 'image/png', undefined, (b, base64) => b.quickSend(base64)),
  close: () => call('close', {}, (b) => b.close()),
  batchProgress: (done: number, total: number, failed: number) =>
    call('batchProgress', { done, total, failed }, (b) => b.batchProgress(done, total, failed)),
  /** True inside the Android app. */
  get available(): boolean {
    return port() !== undefined || legacy() !== undefined;
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
  /** Write a pending document edit now. */
  flush(): void;
}
