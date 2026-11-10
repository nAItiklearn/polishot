/**
 * Typed wrappers for the desktop IPC surface (docs/CONTRACTS.md section 5).
 * Pure pass-through: validation happens on the Rust side.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrWord {
  text: string;
  box: Box;
  line?: number;
}

export type CaptureSource = 'region' | 'window' | 'file' | 'clipboard' | 'scroll';

export interface CaptureMeta {
  id: string;
  width: number;
  height: number;
  createdAt: number;
  source: CaptureSource;
}

export interface WindowInfo {
  hwnd: number;
  title: string;
  app: string;
  /** Physical pixels, virtual-desktop coordinates (same space as `OverlayInfo.bounds`). */
  rect: Box;
  monitor: number;
}

export interface OverlayInfo {
  monitor: number;
  /** Device pixels per CSS pixel for this monitor. */
  scale: number;
  /** Monitor rectangle in physical virtual-desktop pixels (x/y may be negative). */
  bounds: Box;
  windows: WindowInfo[];
  /** Nonce and mode of the active capture session (lets a late-loading overlay catch up). */
  nonce: number;
  mode: CaptureMode;
  purpose: CapturePurpose;
}

export type CaptureRequest =
  | { kind: 'region'; monitor: number; rect: Box }
  | { kind: 'window'; hwnd: number };

export type CaptureMode = 'region' | 'window';

export interface HistoryItem {
  id: string;
  createdAt: number;
  width: number;
  height: number;
  excerpt: string;
  hasDoc: boolean;
}

export interface Settings {
  shortcut: string;
  scrollShortcut: string;
  gifShortcut: string;
  autostart: boolean;
  saveFolder: string;
  format: 'png' | 'jpeg' | 'webp';
  quality: number;
  afterCapture: 'preview' | 'copy';
  theme: 'system' | 'light' | 'dark';
  defaultPreset: string;
  userPresets: string;
}

export interface LicenseStatus {
  /** Pro is active: a valid key whose update window covers this build. */
  licensed: boolean;
  edition?: 'personal' | 'team';
  keyId?: string;
  issuedAt?: number;
  reason?: 'no-key' | 'invalid' | 'updates-expired';
  /** ISO date (YYYY-MM-DD) up to which this key includes updates. */
  updatesUntil?: string;
}

export interface AppInfo {
  version: string;
  backdrop: 'mica' | 'solid';
  /** Non-fatal startup problems, e.g. a global shortcut another app already owns. */
  warnings: string[];
}

/** What the overlay selection is for: a normal capture, a scrolling capture or a GIF region. */
export type CapturePurpose = 'capture' | 'scroll' | 'gif';

export interface ArmPayload {
  nonce: number;
  mode: CaptureMode;
  purpose: CapturePurpose;
  /** Cursor position at arm time, global physical pixels. */
  cursor: { x: number; y: number } | null;
}

export type NavigateTarget = 'history' | 'settings' | 'license';

/** Origin of the custom protocol as seen from a Windows webview. */
export const PROTOCOL_ORIGIN = 'http://polishot.localhost';

export const captureUrl = (id: string): string => `${PROTOCOL_ORIGIN}/capture/${id}`;
export const historyUrl = (id: string): string => `${PROTOCOL_ORIGIN}/history/${id}`;
export const thumbUrl = (id: string): string => `${PROTOCOL_ORIGIN}/thumb/${id}`;
export const frameUrl = (monitor: number, nonce: number): string =>
  `${PROTOCOL_ORIGIN}/frame/${monitor}?v=${nonce}`;

export const ipc = {
  overlayInfo: () => invoke<OverlayInfo>('overlay_info'),
  overlayReady: (nonce: number, decodeMs?: number) =>
    invoke<void>('overlay_ready', { nonce, decodeMs }),
  overlayFocus: () => invoke<void>('overlay_focus'),
  overlaySetMode: (mode: CaptureMode) => invoke<void>('overlay_set_mode', { mode }),
  /** Resolves to the new capture, or `null` when the selection started a scroll/GIF recording. */
  captureCommit: (req: CaptureRequest) => invoke<CaptureMeta | null>('capture_commit', { req }),
  captureCancel: () => invoke<void>('capture_cancel'),
  captureStart: (mode: CaptureMode | 'scroll' | 'gif') => invoke<void>('capture_start', { mode }),
  ocrRecognize: (id: string) => invoke<OcrWord[]>('ocr_recognize', { id }),
  openFile: (path: string) => invoke<CaptureMeta>('open_file', { path }),
  pasteClipboardImage: () => invoke<CaptureMeta | null>('paste_clipboard_image'),
  exportSave: (bytes: Uint8Array, filename: string) =>
    invoke<string>('export_save', bytes, { headers: { 'x-filename': filename } }),
  copyImage: (bytes: Uint8Array) => invoke<void>('copy_image', bytes),
  copyText: (text: string) => invoke<void>('copy_text', { text }),
  shareFile: (path: string) => invoke<void>('share_file', { path }),
  historyList: (args: { query?: string; limit: number; offset: number }) =>
    invoke<HistoryItem[]>('history_list', args),
  historyGet: (id: string) =>
    invoke<{ meta: CaptureMeta; docJson: string | null }>('history_get', { id }),
  historySave: (id: string, docJson: string) => invoke<void>('history_save', { id, docJson }),
  historyDelete: (id: string) => invoke<void>('history_delete', { id }),
  historyClear: () => invoke<void>('history_clear'),
  settingsGet: () => invoke<Settings>('settings_get'),
  settingsSet: (patch: Partial<Settings>) => invoke<Settings>('settings_set', { patch }),
  licenseStatus: () => invoke<LicenseStatus>('license_status'),
  licenseActivate: (key: string) => invoke<LicenseStatus>('license_activate', { key }),
  licenseDeactivate: () => invoke<LicenseStatus>('license_deactivate'),
  pinOpen: (id: string) => invoke<void>('pin_open', { id }),
  pinClose: () => invoke<void>('pin_close'),
  appInfo: () => invoke<AppInfo>('app_info'),
  recordingStop: () => invoke<void>('recording_stop'),
  revealInFolder: (path: string) => invoke<void>('reveal_in_folder', { path }),
  statusClose: () => invoke<void>('status_close'),
};

export const events = {
  onCaptureReady: (cb: (meta: CaptureMeta) => void): Promise<UnlistenFn> =>
    listen<CaptureMeta>('capture:ready', (e) => cb(e.payload)),
  onOcrReady: (cb: (p: { id: string; words: OcrWord[] }) => void): Promise<UnlistenFn> =>
    listen<{ id: string; words: OcrWord[] }>('ocr:ready', (e) => cb(e.payload)),
  onNavigate: (cb: (target: NavigateTarget) => void): Promise<UnlistenFn> =>
    listen<NavigateTarget>('navigate', (e) => cb(e.payload)),
  onOverlayArm: (cb: (p: ArmPayload) => void): Promise<UnlistenFn> =>
    listen<ArmPayload>('overlay:arm', (e) => cb(e.payload)),
  onOverlayMode: (cb: (mode: CaptureMode) => void): Promise<UnlistenFn> =>
    listen<CaptureMode>('overlay:mode', (e) => cb(e.payload)),
  onStatusTick: (cb: (t: { elapsedMs: number; maxMs: number }) => void): Promise<UnlistenFn> =>
    listen<{ elapsedMs: number; maxMs: number }>('status:tick', (e) => cb(e.payload)),
  onGifSaved: (cb: (r: { path: string; name: string; bytes: number }) => void): Promise<UnlistenFn> =>
    listen<{ path: string; name: string; bytes: number }>('gif:saved', (e) => cb(e.payload)),
  onSettingsChanged: (cb: (s: Settings) => void): Promise<UnlistenFn> =>
    listen<Settings>('settings:changed', (e) => cb(e.payload)),
};
