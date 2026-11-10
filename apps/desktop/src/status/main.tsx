/**
 * Small always-on-top status surfaces created on demand by Rust (labels `status-*`). One page,
 * four views chosen by the `view` query parameter:
 *   pill      "Scrolling... Esc to stop" while a scrolling capture runs
 *   border    recording frame around a GIF region (click-through)
 *   controls  timer and Stop button for a GIF recording
 *   toast     result of a recording, with a reveal-in-folder action
 * These windows are excluded from screen capture, so they never end up in a recording.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { events, ipc } from '../ipc';
import '../styles.css';
import './status.css';

const params = new URLSearchParams(window.location.search);

function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function Pill() {
  return (
    <div className="st-pill" role="status" aria-live="polite">
      <span className="st-dot" aria-hidden="true" />
      <span>Scrolling</span>
      <kbd>Esc</kbd>
      <span>to stop</span>
    </div>
  );
}

function Border() {
  return <div className="st-border" aria-hidden="true" />;
}

function Controls() {
  const [elapsed, setElapsed] = useState(0);
  const [maxMs, setMaxMs] = useState(0);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void events.onStatusTick((t) => {
      setElapsed(t.elapsedMs);
      setMaxMs(t.maxMs);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="st-controls" role="group" aria-label="Recording">
      <span className="st-dot st-dot-rec" aria-hidden="true" />
      <span className="mono st-time" aria-live="off">
        {formatClock(elapsed)}
        {maxMs > 0 && <span className="st-dim"> / {formatClock(maxMs)}</span>}
      </span>
      <button
        type="button"
        className="st-btn"
        disabled={stopping}
        onClick={() => {
          setStopping(true);
          void ipc.recordingStop();
        }}
      >
        Stop
      </button>
    </div>
  );
}

function Toast() {
  const kind = params.get('kind') ?? 'info';
  const name = params.get('name') ?? '';
  const path = params.get('path') ?? '';
  const size = Number(params.get('size') ?? '0');
  const message = params.get('message') ?? '';
  const isError = kind === 'error';

  useEffect(() => {
    const t = window.setTimeout(() => void ipc.statusClose(), isError ? 10_000 : 8_000);
    return () => window.clearTimeout(t);
  }, [isError]);

  return (
    <div className={`st-toast${isError ? ' st-toast-error' : ''}`} role="status" aria-live="polite">
      <div className="st-toast-text">
        <strong>{isError ? 'Capture failed' : 'GIF saved'}</strong>
        <span className="st-dim st-ellipsis">
          {isError ? message : `${name}${size > 0 ? `  ·  ${formatBytes(size)}` : ''}`}
        </span>
      </div>
      {!isError && path && (
        <button
          type="button"
          className="st-btn"
          onClick={() => {
            void ipc.revealInFolder(path).finally(() => void ipc.statusClose());
          }}
        >
          Show in folder
        </button>
      )}
      <button
        type="button"
        className="st-icon-btn"
        aria-label="Dismiss"
        onClick={() => void ipc.statusClose()}
      >
        ×
      </button>
    </div>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
  }, []);
  switch (params.get('view')) {
    case 'pill':
      return <Pill />;
    case 'border':
      return <Border />;
    case 'controls':
      return <Controls />;
    case 'toast':
      return <Toast />;
    default:
      return null;
  }
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
