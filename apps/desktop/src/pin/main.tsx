/**
 * Pinned screenshot window (pin-<id>): borderless, always on top. Drag to move, wheel to change
 * opacity, Esc to close. The id comes from the query string and is re-validated by Rust.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { captureUrl, ipc } from '../ipc';
import '../styles.css';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_OPACITY = 0.2;

function Pin() {
  const id = new URLSearchParams(window.location.search).get('id') ?? '';
  const valid = ID_RE.test(id);
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void ipc.pinClose();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setOpacity((o) => Math.min(1, Math.max(MIN_OPACITY, o + (e.deltaY < 0 ? 0.05 : -0.05))));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  if (!valid) return null;

  return (
    <div
      className="h-full w-full"
      data-tauri-drag-region
      onDoubleClick={() => void ipc.pinClose()}
    >
      <img
        src={captureUrl(id)}
        alt="Pinned screenshot"
        draggable={false}
        className="pointer-events-none block h-full w-full object-contain"
        style={{ opacity }}
      />
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
