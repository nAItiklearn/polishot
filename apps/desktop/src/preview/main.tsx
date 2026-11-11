/**
 * Preview window entry (label "preview"): the editor, history, settings and licence screens.
 *
 * In a dev build, opening the page as `?mock=1` swaps the Tauri backend for an in-memory mock so the
 * whole UI can be developed, tested and screenshotted in a plain browser. That branch is removed from
 * production builds.
 */
import { APP_NAME } from '@polishot/brand';
import '@polishot/editor/editor.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isMockRequested } from '../shared/ipc';
import '../styles.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './preview.css';
import { getEditor } from './session';

const THEME_KEY = 'polishot.theme.v1';

async function boot(): Promise<void> {
  if (import.meta.env.DEV && isMockRequested()) {
    const { installMock } = await import('../shared/mock/mockBackend');
    await installMock();
  }
  document.title = APP_NAME;
  // Apply the last theme straight away, so a window that is shown again never flashes the wrong one
  // while the settings load (the app keeps this up to date).
  try {
    const t = window.localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch {
    // storage may be unavailable; the settings will set the theme in a moment
  }
  // The faces are files inside the app. Waiting for them (at most half a second) means the first paint is already in
  // the right type, instead of a stand-in that is swapped a moment later and moves everything.
  await Promise.race([
    Promise.all([
      document.fonts.load('400 13px "Polishot Sans"'),
      document.fonts.load('600 13px "Polishot Sans"'),
      document.fonts.load('400 22px "Polishot Serif"'),
    ]),
    new Promise((resolve) => window.setTimeout(resolve, 500)),
  ]).catch(() => undefined);
  if (import.meta.env.DEV) (window as unknown as { __polishotApp: unknown }).__polishotApp = { editor: getEditor() };
  const root = document.getElementById('root');
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  }
}

void boot();
