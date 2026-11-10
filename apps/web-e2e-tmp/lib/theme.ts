import { useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY } from './theme-script';

/**
 * Theme preference: "system" (default, follows the OS), or an explicit "light" / "dark".
 * The preference is stored in localStorage (never a cookie) and mirrored to <html data-theme>.
 * "system" removes the attribute, which lets the prefers-color-scheme rule in tokens.css apply.
 * THEME_INIT_SCRIPT runs before first paint so there is no flash.
 */
export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const listeners = new Set<() => void>();

function readPref(): ThemePref {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyPref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY || e.key === null) {
      applyPref(readPref());
      onChange();
    }
  };
  media.addEventListener('change', onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    media.removeEventListener('change', onChange);
    window.removeEventListener('storage', onStorage);
  };
}

// The snapshot is a string so React can compare it by value: "<preference>|<system theme>".
const getSnapshot = () => `${readPref()}|${systemTheme()}`;
const getServerSnapshot = () => 'system|light';

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Storage can be blocked; the choice then lasts for this page view only.
  }
  applyPref(pref);
  listeners.forEach((l) => l());
}

export function useTheme(): { pref: ThemePref; resolved: ResolvedTheme; setPref: typeof setThemePref } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [pref, system] = snapshot.split('|') as [ThemePref, ResolvedTheme];
  return { pref, resolved: pref === 'system' ? system : pref, setPref: setThemePref };
}
