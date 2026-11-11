/**
 * Pinned screenshot window (pin-<id>): borderless, always on top. Drag to move, wheel (or the up and down
 * arrow keys) to change opacity, Esc or double-click to close. A small pill with the opacity and a close
 * button appears while the pointer is over the pin, and for a moment when it opens so it can be found.
 * The id comes from the query string and is re-validated by Rust.
 */
import { X } from 'lucide-react';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { captureUrl, ipc } from '../ipc';
import '../styles.css';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_OPACITY = 0.2;
const STEP = 0.05;
const HINT_MS = 2400;

const clampOpacity = (o: number) => Math.round(Math.min(1, Math.max(MIN_OPACITY, o)) * 100) / 100;

function Pin() {
  const id = new URLSearchParams(window.location.search).get('id') ?? '';
  const valid = ID_RE.test(id);
  const [opacity, setOpacity] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [hover, setHover] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);

  const flash = useCallback(() => {
    setShowControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShowControls(false), HINT_MS);
  }, []);

  useEffect(() => {
    flash();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void ipc.pinClose();
      else if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') {
        setOpacity((o) => clampOpacity(o + STEP));
        flash();
      } else if (e.key === 'ArrowDown' || e.key === '-') {
        setOpacity((o) => clampOpacity(o - STEP));
        flash();
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setOpacity((o) => clampOpacity(o + (e.deltaY < 0 ? STEP : -STEP)));
      flash();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
      window.clearTimeout(hideTimer.current);
    };
  }, [flash]);

  const visible = showControls || hover;
  if (!valid) return null;

  return (
    <div
      className="relative h-full w-full"
      data-tauri-drag-region
      onPointerEnter={() => setHover(true)}
      onPointerMove={() => !hover && setHover(true)}
      onPointerLeave={() => setHover(false)}
      onDoubleClick={() => void ipc.pinClose()}
    >
      <img
        src={captureUrl(id)}
        alt="Pinned screenshot"
        draggable={false}
        className="pointer-events-none block h-full w-full object-contain"
        style={{ opacity }}
      />
      <div
        className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-[rgb(28_25_21/0.8)] py-1 pr-1 pl-3 text-[11px] font-medium text-[#f4efe6] shadow-[0_4px_14px_rgb(40_28_14/0.3)] backdrop-blur transition-opacity duration-150"
        style={{ opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none', fontFamily: "'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif" }}
        role="group"
        aria-label="Pin controls"
      >
        <span className="tabular-nums" aria-live="polite">
          {Math.round(opacity * 100)}%
        </span>
        <button
          type="button"
          aria-label="Close pin"
          title="Close (Esc)"
          className="grid h-5 w-5 place-items-center rounded-full text-[#f4efe6] hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-[#f28d63]"
          onClick={() => void ipc.pinClose()}
        >
          <X size={12} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Pin />
    </StrictMode>,
  );
}
