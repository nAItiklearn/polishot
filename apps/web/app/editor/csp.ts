/**
 * Why this file exists. /editor is served with a Content-Security-Policy the other pages do not have: blob
 * workers and WebAssembly, for on-device text recognition (see next.config.ts). A policy belongs to the
 * document the browser loaded. When someone reaches /editor through a client-side <Link> from another page,
 * Next swaps the content but the browser keeps that page's stricter policy, and the recognition engine is
 * blocked ("Text recognition could not start"). A full page load always gets the right policy, so the editor
 * loads itself fresh once when it finds it was not loaded as /editor, and again if the engine is ever blocked.
 */

/** sessionStorage key holding the time of the last reload this module started (milliseconds, as text). */
export const RELOAD_KEY = 'polishot.editor.reloaded';
/** A second reload inside this window is refused, so a wrong guess can never become a reload loop. */
export const RELOAD_WINDOW_MS = 30_000;

/** True or false when the browser says which document it loaded (the policy came with that one); else null. */
export function loadedAsEditorRoute(): boolean | null {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!entry?.name) return null;
    return new URL(entry.name).pathname.replace(/\/+$/, '') === '/editor';
  } catch {
    return null;
  }
}

/**
 * Loads the current URL again from the server, at most once per RELOAD_WINDOW_MS. Returns whether a reload was
 * started. If the guard cannot be stored (storage blocked) it refuses: not being able to remember a reload
 * means not being able to promise it will not repeat.
 */
export function reloadOnce(now: number = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY));
    if (last > 0 && now - last < RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
