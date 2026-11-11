/**
 * App-wide state shared by the views: settings, the licence entitlement, toasts and navigation.
 * Kept in one small context so the editor view, history, settings and licence screens agree.
 */
import type { BrandMark, Editor } from '@polishot/editor';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  errorMessage,
  events,
  ipc,
  type AppInfo,
  type LicenseStatus,
  type Settings,
  type SettingsPatch,
} from '../shared/ipc';
import { loadBrandMark, saveBrandMark } from './lib/brand';
import { entitlementFrom, type Entitlement } from './lib/entitlement';

export type View = 'editor' | 'history' | 'settings' | 'license';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastInput {
  message: string;
  tone?: 'neutral' | 'error';
  action?: ToastAction;
  /** Milliseconds before it fades. Defaults: 3000, 6000 with an action, 6000 for errors. */
  duration?: number;
}

export interface Toast extends ToastInput {
  id: number;
}

/** Shows a toast and returns its id, so a long-running message ("Sending...") can be dismissed when it is done. */
export type Notify = (toast: ToastInput | string) => number;

export interface AppContextValue {
  editor: Editor;
  settings: Settings | null;
  /** Applies a settings patch. Resolves to an error message, or null on success. */
  updateSettings: (patch: SettingsPatch) => Promise<string | null>;
  license: LicenseStatus | null;
  ent: Entitlement;
  setLicense: (s: LicenseStatus) => void;
  info: AppInfo | null;
  /** The Pro brand mark (your own text or logo). The editor ignores it unless Pro is active. */
  brandMark: BrandMark | null;
  /** Remembers a new mark (null clears it). Returns false if it could not be stored. */
  setBrandMark: (mark: BrandMark | null) => boolean;
  notify: Notify;
  dismissToast: (id: number) => void;
  navigate: (view: View) => void;
  view: View;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp must be used inside <AppProvider>.');
  return v;
}

/* ------------------------------------------------------------------ */
/* Hooks the App component composes                                     */
/* ------------------------------------------------------------------ */

export function useToasts(): { toasts: Toast[]; notify: Notify; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t !== undefined) window.clearTimeout(t);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const notify = useCallback<Notify>(
    (input) => {
      const t: ToastInput = typeof input === 'string' ? { message: input } : input;
      if (!t.message) return 0;
      const id = next.current++;
      const duration = t.duration ?? (t.action || t.tone === 'error' ? 6000 : 3000);
      setToasts((list) => {
        // The same message twice in a row replaces itself instead of stacking.
        const rest = list.filter((x) => x.message !== t.message);
        return [...rest, { ...t, id }].slice(-3);
      });
      timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const live = timers.current;
    return () => {
      live.forEach((h) => window.clearTimeout(h));
      live.clear();
    };
  }, []);

  return { toasts, notify, dismiss };
}

/** Settings from the backend, kept fresh by `settings:changed`. */
export function useSettingsState(): {
  settings: Settings | null;
  updateSettings: (patch: SettingsPatch) => Promise<string | null>;
} {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let alive = true;
    ipc
      .settingsGet()
      .then((s) => alive && setSettings(s))
      .catch(() => undefined);
    const off = events.onSettingsChanged((s) => setSettings(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const updateSettings = useCallback(async (patch: SettingsPatch) => {
    try {
      setSettings(await ipc.settingsSet(patch));
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  }, []);

  return { settings, updateSettings };
}

/** Licence status and the entitlement derived from it (unknown = Free). */
export function useLicenseState(): { license: LicenseStatus | null; ent: Entitlement; setLicense: (s: LicenseStatus) => void } {
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  useEffect(() => {
    let alive = true;
    ipc
      .licenseStatus()
      .then((s) => alive && setLicense(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const ent = useMemo(() => entitlementFrom(license), [license]);
  return { license, ent, setLicense };
}

/** The Pro brand mark, remembered in the webview's local storage. */
export function useBrandMarkState(): { brandMark: BrandMark | null; setBrandMark: (mark: BrandMark | null) => boolean } {
  const [brandMark, setMark] = useState<BrandMark | null>(() => loadBrandMark(safeStorage()));
  const setBrandMark = useCallback((mark: BrandMark | null) => {
    if (!saveBrandMark(safeStorage(), mark)) return false;
    // Read it back so what is shown is exactly what was stored (and validated).
    setMark(loadBrandMark(safeStorage()));
    return true;
  }, []);
  return { brandMark, setBrandMark };
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
