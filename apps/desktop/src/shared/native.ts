/**
 * Window controls and native dialogs behind one swappable object, so the UI never imports the Tauri
 * window or dialog APIs directly and the mock mode (plain browser) can stand in for them.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';

export type Unlisten = () => void;

export interface NativeApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  /** Hides the preview window; the app keeps running in the tray. */
  hide(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Calls back whenever the window is resized (maximise state may have changed). */
  onResized(cb: () => void): Promise<Unlisten>;
  /** Image file chooser. Null when cancelled. */
  pickImage(): Promise<string | null>;
  /** Image chooser that allows several files (batch). Empty when cancelled. */
  pickImages(): Promise<string[]>;
  /** Folder chooser. Null when cancelled. */
  pickFolder(defaultPath?: string): Promise<string | null>;
  /** Save As chooser for an export. Null when cancelled. */
  pickSavePath(opts: { defaultPath: string; extension: string }): Promise<string | null>;
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp'] as const;

const FORMAT_LABEL: Record<string, string> = { png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', webp: 'WebP image' };

const tauriNative: NativeApi = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  hide: () => getCurrentWindow().hide(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  onResized: (cb) => getCurrentWindow().onResized(() => cb()),

  async pickImage() {
    const r = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }],
    });
    return typeof r === 'string' ? r : null;
  },

  async pickImages() {
    const r = await open({
      multiple: true,
      directory: false,
      filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }],
    });
    return Array.isArray(r) ? r.filter((p): p is string => typeof p === 'string') : [];
  },

  async pickFolder(defaultPath) {
    const r = await open({ multiple: false, directory: true, defaultPath: defaultPath || undefined });
    return typeof r === 'string' ? r : null;
  },

  async pickSavePath({ defaultPath, extension }) {
    const ext = extension.replace(/^\./, '').toLowerCase();
    const r = await save({
      defaultPath,
      filters: [{ name: FORMAT_LABEL[ext] ?? 'Image', extensions: [ext] }],
    });
    return typeof r === 'string' ? r : null;
  },
};

export let native: NativeApi = tauriNative;

/** Replace the native layer (dev mock). Pass null to restore Tauri. */
export function setNative(n: NativeApi | null): void {
  native = n ?? tauriNative;
}

/**
 * Resolves once the page is no longer visible (the window was hidden), or after `timeoutMs`, whichever comes
 * first. Register it BEFORE asking the window to hide, so the event cannot be missed.
 */
export function whenHidden(timeoutMs = 400): Promise<void> {
  if (typeof document === 'undefined' || document.visibilityState === 'hidden') return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const finish = () => {
      document.removeEventListener('visibilitychange', onChange);
      window.clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (document.visibilityState === 'hidden') finish();
    };
    timer = window.setTimeout(finish, timeoutMs);
    document.addEventListener('visibilitychange', onChange);
  });
}

/** One compositor pass or two: after the window reports hidden, Windows still needs a moment to stop drawing it. */
export const HIDE_SETTLE_MS = 60;

/**
 * Hides the window and returns when it is really gone from the screen, so a frozen frame of the desktop taken next
 * cannot contain it. This replaces a fixed 220 ms sleep: the webview says "hidden" within a frame or two, and a
 * short settle covers the compositor. If the event never comes (it is only a safety net) it gives up after 400 ms.
 */
export async function hideAndSettle(settleMs: number = HIDE_SETTLE_MS): Promise<void> {
  const hidden = whenHidden();
  await native.hide().catch(() => undefined);
  await hidden;
  await new Promise<void>((resolve) => window.setTimeout(resolve, settleMs));
}
