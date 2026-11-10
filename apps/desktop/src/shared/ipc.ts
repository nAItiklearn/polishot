/**
 * Typed client for the desktop IPC surface used by the preview window (CONTRACTS section 5, 5b and
 * the "Desktop IPC" additions in CONTRACT-CHANGES.md). Overlay-only commands (`overlay_*`,
 * `capture_commit`, `capture_cancel`) live in the overlay's own client, `src/ipc/index.ts`.
 *
 * What this layer adds on top of raw `invoke`:
 * - every failure becomes an {@link IpcError} whose `message` is a readable sentence;
 * - payloads coming from Rust are shape-checked before the UI touches them;
 * - a swappable {@link Transport}, so the same UI runs against a mock backend in a plain browser
 *   (`?mock=1` in dev) and against Tauri in the app.
 */
import { invoke, type InvokeArgs, type InvokeOptions as TauriInvokeOptions } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Box, OcrWord } from '@polishot/redact';

export type { Box, OcrWord };

/* ------------------------------------------------------------------ */
/* Types (CONTRACTS section 5, 5b)                                      */
/* ------------------------------------------------------------------ */

export type CaptureSource = 'region' | 'window' | 'file' | 'clipboard' | 'scroll';

export interface CaptureMeta {
  id: string;
  width: number;
  height: number;
  /** Unix epoch milliseconds. */
  createdAt: number;
  source: CaptureSource;
}

export interface HistoryItem {
  id: string;
  /** Unix epoch milliseconds. */
  createdAt: number;
  width: number;
  height: number;
  excerpt: string;
  hasDoc: boolean;
}

export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type ThemeSetting = 'system' | 'light' | 'dark';
export type AfterCapture = 'preview' | 'copy';

export interface Settings {
  shortcut: string;
  /** Empty string = disabled. */
  scrollShortcut: string;
  /** Empty string = disabled. */
  gifShortcut: string;
  autostart: boolean;
  saveFolder: string;
  format: ImageFormat;
  /** 0.1 to 1. */
  quality: number;
  afterCapture: AfterCapture;
  theme: ThemeSetting;
  defaultPreset: string;
  /** JSON array of saved looks, owned by the editor UI. */
  userPresets: string;
}

export type SettingsPatch = Partial<Settings>;

export type LicenseReason = 'no-key' | 'invalid' | 'updates-expired';

export interface LicenseStatus {
  /** True when Pro is active for this build. */
  licensed: boolean;
  edition?: 'personal' | 'team';
  keyId?: string;
  /** Unix epoch milliseconds. */
  issuedAt?: number;
  /** Set whenever `licensed` is false (section 5b). */
  reason?: LicenseReason;
  /** ISO date (YYYY-MM-DD) the key's update window ends. */
  updatesUntil?: string;
}

export interface AppInfo {
  version: string;
  backdrop: 'mica' | 'solid';
  warnings: string[];
}

export type NavigateTarget = 'history' | 'settings' | 'license';
export type CaptureMode = 'region' | 'window';

export interface HistoryEntry {
  meta: CaptureMeta;
  docJson: string | null;
}

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

export const GENERIC_ERROR = 'Something went wrong. Please try again.';
const MAX_ERROR_LENGTH = 400;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Tauri's own failures (missing permission, missing command) are not sentences for a person. */
const TRANSPORT_FAILURES: ReadonlyArray<[RegExp, string]> = [
  [/not allowed|not found.*command|command .* not found|plugin .* not found|forbidden/i, 'That action is not available in this build.'],
  [/__TAURI_INTERNALS__|__TAURI__|ipc.*(unavailable|not available)/i, 'The app backend is not running.'],
  [/failed to fetch|networkerror|load failed/i, 'The app could not reach its backend.'],
];

/**
 * Turns whatever a rejected invoke produced (Tauri rejects with the `Err(String)` of the command, but
 * plugins and the webview produce Errors and objects) into one short, readable sentence.
 */
export function errorMessage(e: unknown, fallback: string = GENERIC_ERROR): string {
  let text: string | undefined;
  if (typeof e === 'string') text = e;
  else if (e instanceof Error) text = e.message;
  else if (isRecord(e) && typeof e.message === 'string') text = e.message;
  else if (isRecord(e) && typeof e.error === 'string') text = e.error;
  // Strip control characters so an error can never break a layout or a log line.
  text = text?.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  for (const [pattern, friendly] of TRANSPORT_FAILURES) if (pattern.test(text)) return friendly;
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

export class IpcError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.name = 'IpcError';
    this.command = command;
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                            */
/* ------------------------------------------------------------------ */

export interface InvokeOptions {
  headers?: Record<string, string>;
}

export interface Transport {
  invoke(cmd: string, args?: unknown, options?: InvokeOptions): Promise<unknown>;
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

const tauriTransport: Transport = {
  invoke: (cmd, args, options) => invoke(cmd, args as InvokeArgs | undefined, options as TauriInvokeOptions | undefined),
  listen: (event, handler) => listen<unknown>(event, (e) => handler(e.payload)),
};

let transport: Transport = tauriTransport;

/** Swap the transport (the dev-only mock backend). Pass null to go back to Tauri. */
export function setTransport(t: Transport | null): void {
  transport = t ?? tauriTransport;
}

/** True when the page was opened as `?mock=1` in a dev build. Never true in a production build. */
export function isMockRequested(): boolean {
  if (!import.meta.env.DEV || typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('mock') === '1';
}

async function call<T>(cmd: string, args?: unknown, options?: InvokeOptions): Promise<T> {
  try {
    return (await transport.invoke(cmd, args, options)) as T;
  } catch (e) {
    throw new IpcError(cmd, errorMessage(e));
  }
}

/* ------------------------------------------------------------------ */
/* Image URLs (custom protocol)                                         */
/* ------------------------------------------------------------------ */

/** Origin of the `polishot://` protocol as seen from a Windows webview. */
export const PROTOCOL_ORIGIN = 'http://polishot.localhost';
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface UrlResolver {
  capture(id: string): string;
  history(id: string): string;
  thumb(id: string): string;
}

const protocolResolver: UrlResolver = {
  capture: (id) => `${PROTOCOL_ORIGIN}/capture/${id}`,
  history: (id) => `${PROTOCOL_ORIGIN}/history/${id}`,
  thumb: (id) => `${PROTOCOL_ORIGIN}/thumb/${id}`,
};

let resolver: UrlResolver = protocolResolver;

export function setUrlResolver(r: UrlResolver | null): void {
  resolver = r ?? protocolResolver;
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

function checkedId(id: string): string {
  if (!isValidId(id)) throw new IpcError('protocol', 'That capture id is not valid.');
  return id;
}

/** URL of the full image. The Content-Type may be image/bmp until the PNG is written; rely on it, not the URL. */
export const captureUrl = (id: string): string => resolver.capture(checkedId(id));
export const historyUrl = (id: string): string => resolver.history(checkedId(id));
export const thumbUrl = (id: string): string => resolver.thumb(checkedId(id));

/* ------------------------------------------------------------------ */
/* Payload checks                                                       */
/* ------------------------------------------------------------------ */

const SOURCES: readonly CaptureSource[] = ['region', 'window', 'file', 'clipboard', 'scroll'];

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function isCaptureMeta(v: unknown): v is CaptureMeta {
  return (
    isRecord(v) &&
    isValidId(v.id) &&
    finite(v.width) &&
    finite(v.height) &&
    v.width > 0 &&
    v.height > 0 &&
    finite(v.createdAt) &&
    typeof v.source === 'string' &&
    (SOURCES as readonly string[]).includes(v.source)
  );
}

function checkedMeta(cmd: string, v: unknown): CaptureMeta {
  if (!isCaptureMeta(v)) throw new IpcError(cmd, 'The app returned an image this window does not understand.');
  return v;
}

const MAX_WORDS = 20_000;

/** Keeps only well-formed OCR words (finite boxes, string text). The text layer renders what it gets. */
export function sanitizeWords(input: unknown): OcrWord[] {
  if (!Array.isArray(input)) return [];
  const out: OcrWord[] = [];
  for (const w of input) {
    if (out.length >= MAX_WORDS) break;
    if (!isRecord(w) || typeof w.text !== 'string' || w.text.length === 0 || w.text.length > 200) continue;
    const b = w.box;
    if (!isRecord(b) || !finite(b.x) || !finite(b.y) || !finite(b.w) || !finite(b.h) || b.w <= 0 || b.h <= 0) continue;
    const word: OcrWord = { text: w.text, box: { x: b.x, y: b.y, w: b.w, h: b.h } };
    if (finite(w.line)) word.line = w.line;
    out.push(word);
  }
  return out;
}

function sanitizeHistory(input: unknown): HistoryItem[] {
  if (!Array.isArray(input)) return [];
  const out: HistoryItem[] = [];
  for (const r of input) {
    if (!isRecord(r) || !isValidId(r.id) || !finite(r.createdAt) || !finite(r.width) || !finite(r.height)) continue;
    out.push({
      id: r.id,
      createdAt: r.createdAt,
      width: r.width,
      height: r.height,
      excerpt: typeof r.excerpt === 'string' ? r.excerpt : '',
      hasDoc: r.hasDoc === true,
    });
  }
  return out;
}

/** Header values must be ASCII; the file name is generated by us, but never trust it blindly. */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_');
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

export const ipc = {
  /** Same as the capture hotkey. */
  captureStart: (mode: CaptureMode) => call<void>('capture_start', { mode }),

  ocrRecognize: async (id: string): Promise<OcrWord[]> => sanitizeWords(await call<unknown>('ocr_recognize', { id: checkedId(id) })),

  openFile: async (path: string): Promise<CaptureMeta> => checkedMeta('open_file', await call<unknown>('open_file', { path })),

  pasteClipboardImage: async (): Promise<CaptureMeta | null> => {
    const r = await call<unknown>('paste_clipboard_image');
    return r == null ? null : checkedMeta('paste_clipboard_image', r);
  },

  /**
   * Writes an export into the configured save folder and returns the path it was saved to.
   * `savePath` is an optional absolute destination chosen in a Save As dialog (header `x-save-path`,
   * percent-encoded UTF-8). If the backend does not honour it, the returned path says where the file
   * really went, and callers should report that path.
   */
  exportSave: (bytes: Uint8Array, filename: string, opts: { savePath?: string } = {}) => {
    const headers: Record<string, string> = { 'x-filename': headerSafe(filename) };
    if (opts.savePath) headers['x-save-path'] = encodeURIComponent(opts.savePath);
    return call<string>('export_save', bytes, { headers });
  },

  /** PNG bytes to the clipboard. */
  copyImage: (bytes: Uint8Array) => call<void>('copy_image', bytes),
  copyText: (text: string) => call<void>('copy_text', { text }),
  shareFile: (path: string) => call<void>('share_file', { path }),

  historyList: async (args: { query?: string; limit: number; offset: number }): Promise<HistoryItem[]> => {
    const query = args.query?.trim();
    return sanitizeHistory(await call<unknown>('history_list', { query: query ? query : undefined, limit: args.limit, offset: args.offset }));
  },

  historyGet: async (id: string): Promise<HistoryEntry> => {
    const r = await call<unknown>('history_get', { id: checkedId(id) });
    if (!isRecord(r)) throw new IpcError('history_get', 'That history item could not be read.');
    return { meta: checkedMeta('history_get', r.meta), docJson: typeof r.docJson === 'string' ? r.docJson : null };
  },

  historySave: (id: string, docJson: string) => call<void>('history_save', { id: checkedId(id), docJson }),
  historyDelete: (id: string) => call<void>('history_delete', { id: checkedId(id) }),
  historyClear: () => call<void>('history_clear'),

  settingsGet: () => call<Settings>('settings_get'),
  settingsSet: (patch: SettingsPatch) => call<Settings>('settings_set', { patch }),

  licenseStatus: () => call<LicenseStatus>('license_status'),
  licenseActivate: (key: string) => call<LicenseStatus>('license_activate', { key }),
  licenseDeactivate: () => call<LicenseStatus>('license_deactivate'),

  pinOpen: (id: string) => call<void>('pin_open', { id: checkedId(id) }),
  appInfo: () => call<AppInfo>('app_info'),

  /**
   * Shows a saved file in Explorer. Uses the opener plugin's command; if the plugin is not part of
   * this build the promise rejects with a readable message and the UI falls back to copying the path.
   */
  revealInFolder: (path: string) => call<void>('plugin:opener|reveal_item_in_dir', { paths: [path] }),

  /** Opens an https URL in the default browser (opener plugin). Anything else is refused. */
  openUrl: (url: string) => {
    if (!/^https:\/\/[^\s]+$/i.test(url)) return Promise.reject(new IpcError('open_url', 'Only secure web links can be opened.'));
    return call<void>('plugin:opener|open_url', { url });
  },
};

/* ------------------------------------------------------------------ */
/* Events                                                               */
/* ------------------------------------------------------------------ */

export type Unlisten = () => void;

/**
 * Subscribes to an event and returns a synchronous unsubscribe function, safe to call before the
 * (async) registration finishes, which is the shape React effect cleanups need.
 */
function subscribe<T>(event: string, accept: (payload: unknown) => T | undefined, cb: (value: T) => void): Unlisten {
  let cancelled = false;
  let off: (() => void) | undefined;
  transport
    .listen(event, (payload) => {
      if (cancelled) return;
      const value = accept(payload);
      if (value !== undefined) cb(value);
    })
    .then((fn) => {
      if (cancelled) fn();
      else off = fn;
    })
    .catch(() => {
      // Registration failure is not fatal: the app just does not receive this event.
    });
  return () => {
    cancelled = true;
    off?.();
    off = undefined;
  };
}

const pass = <T>(v: unknown) => v as T;

export interface FileDrop {
  paths: string[];
}

export const events = {
  onCaptureReady: (cb: (meta: CaptureMeta) => void) => subscribe('capture:ready', (p) => (isCaptureMeta(p) ? p : undefined), cb),

  onOcrReady: (cb: (p: { id: string; words: OcrWord[] }) => void) =>
    subscribe<{ id: string; words: OcrWord[] }>(
      'ocr:ready',
      (p) => (isRecord(p) && isValidId(p.id) ? { id: p.id, words: sanitizeWords(p.words) } : undefined),
      cb,
    ),

  onNavigate: (cb: (target: NavigateTarget) => void) =>
    subscribe<NavigateTarget>('navigate', (p) => (p === 'history' || p === 'settings' || p === 'license' ? p : undefined), cb),

  onSettingsChanged: (cb: (s: Settings) => void) => subscribe<Settings>('settings:changed', (p) => (isRecord(p) ? pass<Settings>(p) : undefined), cb),

  /** A hotkey capture failed in Rust (for example a protected window). */
  onCaptureError: (cb: (message: string) => void) => subscribe<string>('capture:error', (p) => errorMessage(p), cb),

  /** The scroll or GIF shortcut was pressed. */
  onShortcutExtra: (cb: (which: 'scroll' | 'gif') => void) =>
    subscribe<'scroll' | 'gif'>('shortcut:extra', (p) => (p === 'scroll' || p === 'gif' ? p : undefined), cb),

  /** Files dropped on the window (Tauri reports real paths). */
  onFileDrop: (cb: (drop: FileDrop) => void) =>
    subscribe<FileDrop>(
      'tauri://drag-drop',
      (p) => {
        if (!isRecord(p) || !Array.isArray(p.paths)) return undefined;
        const paths = p.paths.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 1024);
        return paths.length ? { paths } : undefined;
      },
      cb,
    ),

  onDragEnter: (cb: () => void) => subscribe<true>('tauri://drag-enter', () => true, cb),
  onDragLeave: (cb: () => void) => subscribe<true>('tauri://drag-leave', () => true, cb),
};

/* ------------------------------------------------------------------ */
/* Bytes                                                                */
/* ------------------------------------------------------------------ */

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
