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
/** What `capture_start` can begin: the same four flows as the hotkeys and the tray. */
export type CaptureMode = 'region' | 'window' | 'scroll' | 'gif';

export interface HistoryEntry {
  meta: CaptureMeta;
  docJson: string | null;
}

/* ---- Quick send (CONTRACT-CHANGES, "Quick send") ---- */

/** One row of the device list. Paired devices first, then unpaired devices visible on the network. */
export interface DeviceEntry {
  /** 16 base32 characters. */
  id: string;
  name: string;
  paired: boolean;
  /** Visible on the local network right now. */
  online: boolean;
}

export type PairRole = 'initiator' | 'responder';

/** The code both screens must show before two devices trust each other. */
export interface PairCode {
  /** Six digits grouped for reading: "042 917". */
  sas: string;
  peerName: string;
  peerId: string;
  role: PairRole;
}

/** A paired device wants to send this PC an image; answer with `qsIncomingRespond`. */
export interface IncomingFile {
  requestId: number;
  peerName: string;
  name: string;
  mime: string;
  size: number;
}

/** An accepted image, already registered like any other capture. */
export interface ReceivedImage {
  meta: CaptureMeta;
  peerName: string;
}

/** A finished GIF recording. */
export interface GifSaved {
  path: string;
  name: string;
  bytes: number;
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

/** Device ids are 16 base32 characters; accept a little slack, but never anything that is not alphanumeric. */
const DEVICE_ID_RE = /^[A-Za-z0-9]{8,32}$/;
const SAS_RE = /^\d{3} \d{3}$/;
const MAX_DEVICES = 64;
/** What a person sees: names come from other devices, so strip anything that could break a layout. */
const MAX_NAME = 64;

export function isValidDeviceId(id: unknown): id is string {
  return typeof id === 'string' && DEVICE_ID_RE.test(id);
}

function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  // Control, bidirectional-override and line-break characters have no place in a device name.
  const t = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return t || fallback;
}

export function sanitizeDevice(v: unknown): DeviceEntry | null {
  if (!isRecord(v) || !isValidDeviceId(v.id)) return null;
  return { id: v.id, name: cleanName(v.name, 'Phone'), paired: v.paired === true, online: v.online === true };
}

/** Keeps well-formed device rows only; the list comes from the network, so it is treated as untrusted. */
export function sanitizeDevices(input: unknown): DeviceEntry[] {
  if (!Array.isArray(input)) return [];
  const out: DeviceEntry[] = [];
  for (const r of input) {
    if (out.length >= MAX_DEVICES) break;
    const d = sanitizeDevice(r);
    if (d && !out.some((o) => o.id === d.id)) out.push(d);
  }
  return out;
}

export function sanitizePairCode(v: unknown): PairCode | null {
  if (!isRecord(v) || typeof v.sas !== 'string' || !SAS_RE.test(v.sas) || !isValidDeviceId(v.peerId)) return null;
  if (v.role !== 'initiator' && v.role !== 'responder') return null;
  return { sas: v.sas, peerName: cleanName(v.peerName, 'Phone'), peerId: v.peerId, role: v.role };
}

function sanitizeIncoming(v: unknown): IncomingFile | undefined {
  if (!isRecord(v) || !finite(v.requestId) || !Number.isInteger(v.requestId) || v.requestId < 0) return undefined;
  if (!finite(v.size) || v.size < 0) return undefined;
  return {
    requestId: v.requestId,
    peerName: cleanName(v.peerName, 'A paired device'),
    name: cleanName(v.name, 'image'),
    mime: typeof v.mime === 'string' ? v.mime.slice(0, 64) : '',
    size: v.size,
  };
}

function sanitizeGifSaved(v: unknown): GifSaved | undefined {
  if (!isRecord(v) || typeof v.path !== 'string' || !v.path || v.path.length > 1024) return undefined;
  const name = typeof v.name === 'string' && v.name ? v.name.slice(0, 200) : v.path.split(/[\\/]/).pop() ?? 'recording.gif';
  return { path: v.path, name, bytes: finite(v.bytes) && v.bytes >= 0 ? v.bytes : 0 };
}

/** Header values must be ASCII; the file name is generated by us, but never trust it blindly. */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_');
}

function checkedDeviceId(id: string): string {
  if (!isValidDeviceId(id)) throw new IpcError('quick_send', 'That device is not valid.');
  return id;
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

  /**
   * Tells the backend the styled image for `id` is on screen (editor loaded, first frame presented), so it can show
   * the preview window now and never an empty card. Harmless when the window is already visible; an older backend
   * without the command just rejects, which callers ignore.
   */
  previewReady: (id: string) => call<void>('preview_ready', { id: checkedId(id) }),
  appInfo: () => call<AppInfo>('app_info'),

  /**
   * Quick send. Nothing here is called at launch: the first `qsDevices` or `qsPairingMode` call is what
   * brings up the network listener (and with it the Windows Firewall prompt), unless a device is
   * already paired.
   */
  qsDevices: async (): Promise<DeviceEntry[]> => sanitizeDevices(await call<unknown>('qs_devices')),
  /** Opens or closes the window in which other devices may pair with this PC. Closes itself after 5 minutes. */
  qsPairingMode: (open: boolean) => call<void>('qs_pairing_mode', { open }),
  /** Dials a visible device and starts pairing. Resolves to the code both screens must show. */
  qsPairStart: async (deviceId: string): Promise<PairCode> => {
    const code = sanitizePairCode(await call<unknown>('qs_pair_start', { deviceId: checkedDeviceId(deviceId) }));
    if (!code) throw new IpcError('qs_pair_start', 'The other device sent something this app does not understand.');
    return code;
  },
  /**
   * The user's answer to "do both screens show this code?", for the code that was on screen: the backend
   * only accepts it if `peerId` and `sas` are those of the pairing it is waiting on, so an answer can never be
   * applied to a different device's prompt. Resolves to the newly paired device.
   */
  qsPairConfirm: async (accepted: boolean, code: Pick<PairCode, 'peerId' | 'sas'>): Promise<DeviceEntry> => {
    const device = sanitizeDevice(
      await call<unknown>('qs_pair_confirm', { accepted, peerId: checkedDeviceId(code.peerId), sas: code.sas }),
    );
    if (!device) throw new IpcError('qs_pair_confirm', 'The other device sent something this app does not understand.');
    return device;
  },
  /** Sends PNG bytes to a paired, nearby device. The receiver decides whether to accept. */
  qsSend: (bytes: Uint8Array, deviceId: string, filename: string) =>
    call<void>('qs_send', bytes, { headers: { 'x-device-id': checkedDeviceId(deviceId), 'x-filename': headerSafe(filename) } }),
  qsForget: (deviceId: string) => call<void>('qs_forget', { deviceId: checkedDeviceId(deviceId) }),
  qsIncomingRespond: (requestId: number, accept: boolean) => call<void>('qs_incoming_respond', { requestId, accept }),

  /** Shows a file from the save folder in Explorer (the backend refuses anything outside it). */
  revealSaved: (path: string) => call<void>('reveal_in_folder', { path }),

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

  /** A GIF recording finished and was written to the save folder. */
  onGifSaved: (cb: (gif: GifSaved) => void) => subscribe<GifSaved>('gif:saved', sanitizeGifSaved, cb),

  /** The device list changed (a phone appeared or left, pairing finished, a device was forgotten). */
  onQsDevices: (cb: () => void) => subscribe<true>('qs:devices', () => true, cb),

  /** Pairing reached the "compare the codes" step, started from this PC or from a phone. */
  onQsPairCode: (cb: (code: PairCode) => void) => subscribe<PairCode>('qs:pair-code', (p) => sanitizePairCode(p) ?? undefined, cb),

  /** A paired device wants to send an image. Never auto-accepted. */
  onQsIncoming: (cb: (file: IncomingFile) => void) => subscribe<IncomingFile>('qs:incoming', sanitizeIncoming, cb),

  /** An accepted image arrived and is registered; open it like a fresh capture. */
  onQsReceived: (cb: (r: ReceivedImage) => void) =>
    subscribe<ReceivedImage>(
      'qs:received',
      (p) => (isRecord(p) && isCaptureMeta(p.meta) ? { meta: p.meta, peerName: cleanName(p.peerName, 'a paired device') } : undefined),
      cb,
    ),

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
