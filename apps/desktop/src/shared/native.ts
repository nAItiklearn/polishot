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
