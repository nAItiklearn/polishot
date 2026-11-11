/**
 * Capture overlay. One instance lives in every `overlay-<n>` window (one per monitor), hidden until
 * Rust arms it with a frozen frame. The hot path (pointer move) writes DOM styles directly from a
 * single rAF callback; React only owns the coarse state (mode, errors, hint text).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  events,
  frameUrl,
  ipc,
  type ArmPayload,
  type Box,
  type CaptureMode,
  type CapturePurpose,
  type OverlayInfo,
  type WindowInfo,
} from '../ipc';
import {
  MIN_DRAG_PX,
  clampPoint,
  cssRectToPhysical,
  formatSize,
  hitTestWindow,
  loupeSample,
  normalizeRect,
  placeNear,
  snapToDevicePixel,
  windowRectToCss,
  type Point,
} from './geometry';
import './overlay.css';

const LOUPE_GRID = 16; // physical pixels sampled per side
const LOUPE_CSS = 128; // loupe size in CSS px (8 css px per sampled pixel)

interface Live {
  nonce: number;
  info: OverlayInfo | null;
  mode: CaptureMode;
  purpose: CapturePurpose;
  cursor: Point | null;
  anchor: Point | null;
  dragging: boolean;
  hover: WindowInfo | null;
  busy: boolean;
  focusRequested: boolean;
  raf: number | null;
}

const errorMessage = (e: unknown): string => (typeof e === 'string' ? e : 'Capture failed.');

export function Overlay() {
  const frameRef = useRef<HTMLImageElement>(null);
  const hLineRef = useRef<HTMLDivElement>(null);
  const vLineRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const selRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const winLabelRef = useRef<HTMLDivElement>(null);
  const loupeRef = useRef<HTMLDivElement>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement>(null);
  const loupeCoordsRef = useRef<HTMLSpanElement>(null);

  const live = useRef<Live>({
    nonce: 0,
    info: null,
    mode: 'region',
    purpose: 'capture',
    cursor: null,
    anchor: null,
    dragging: false,
    hover: null,
    busy: false,
    focusRequested: false,
    raf: null,
  });

  const [mode, setMode] = useState<CaptureMode>('region');
  const [purpose, setPurpose] = useState<CapturePurpose>('capture');
  // Remounts the hint on every arm so its fade-out animation restarts.
  const [armCount, setArmCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- rendering (imperative, rAF-coalesced) ------------------------------------------------

  const draw = useCallback(() => {
    const st = live.current;
    st.raf = null;
    const info = st.info;
    const img = frameRef.current;
    if (!info || !img) return;
    const c = st.cursor;
    const scale = info.scale;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Crosshair (region mode only), snapped to device pixels so 1px lines stay crisp.
    const showCross = st.mode === 'region' && c !== null;
    if (hLineRef.current && vLineRef.current) {
      hLineRef.current.style.display = showCross ? 'block' : 'none';
      vLineRef.current.style.display = showCross ? 'block' : 'none';
      if (c && showCross) {
        vLineRef.current.style.transform = `translateX(${snapToDevicePixel(c.x, scale)}px)`;
        hLineRef.current.style.transform = `translateY(${snapToDevicePixel(c.y, scale)}px)`;
      }
    }

    // Selection rectangle: drag rect in region mode, hovered window in window mode.
    let sel: Box | null = null;
    let label = '';
    if (st.mode === 'region' && st.dragging && st.anchor && c) {
      sel = normalizeRect(st.anchor, c);
      const p = cssRectToPhysical(sel, scale, img.naturalWidth, img.naturalHeight);
      label = formatSize(p.w, p.h);
    } else if (st.mode === 'window' && st.hover) {
      sel = windowRectToCss(st.hover.rect, info.bounds, scale);
      label = `${formatSize(st.hover.rect.w, st.hover.rect.h)}`;
    }

    const selEl = selRef.current;
    const dimEl = dimRef.current;
    if (selEl && dimEl) {
      selEl.style.display = sel ? 'block' : 'none';
      dimEl.style.display = sel ? 'none' : 'block';
      if (sel) {
        selEl.style.left = `${sel.x}px`;
        selEl.style.top = `${sel.y}px`;
        selEl.style.width = `${sel.w}px`;
        selEl.style.height = `${sel.h}px`;
      }
    }

    const ro = readoutRef.current;
    if (ro) {
      if (sel && label) {
        ro.style.display = 'block';
        ro.textContent = label;
        const w = ro.offsetWidth;
        const h = ro.offsetHeight;
        let top = sel.y + sel.h + 8;
        if (top + h > vh) top = sel.y - h - 8;
        if (top < 0) top = sel.y + 8;
        const left = Math.min(Math.max(sel.x, 0), Math.max(0, vw - w));
        ro.style.transform = `translate(${left}px, ${top}px)`;
      } else {
        ro.style.display = 'none';
      }
    }

    const wl = winLabelRef.current;
    if (wl) {
      if (st.mode === 'window' && st.hover && sel) {
        wl.style.display = 'block';
        wl.textContent = st.hover.title || st.hover.app;
        const h = wl.offsetHeight;
        const top = sel.y - h - 6 >= 0 ? sel.y - h - 6 : sel.y + 6;
        wl.style.transform = `translate(${Math.max(0, sel.x)}px, ${top}px)`;
      } else {
        wl.style.display = 'none';
      }
    }

    // Loupe (region mode): magnified physical pixels around the cursor.
    const lp = loupeRef.current;
    const canvas = loupeCanvasRef.current;
    if (lp && canvas) {
      if (c && st.mode === 'region' && img.naturalWidth > 0) {
        lp.style.display = 'block';
        const pos = placeNear(c, { w: LOUPE_CSS, h: LOUPE_CSS + 24 }, { w: vw, h: vh }, 24);
        lp.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        const px = Math.min(Math.max(Math.floor(c.x * scale), 0), img.naturalWidth - 1);
        const py = Math.min(Math.max(Math.floor(c.y * scale), 0), img.naturalHeight - 1);
        const dpr = window.devicePixelRatio || 1;
        const side = Math.round(LOUPE_CSS * dpr);
        if (canvas.width !== side) {
          canvas.width = side;
          canvas.height = side;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, side, side);
          const s = loupeSample({ x: px, y: py }, LOUPE_GRID, side, img.naturalWidth, img.naturalHeight);
          if (s) ctx.drawImage(img, s.sx, s.sy, s.sw, s.sh, s.dx, s.dy, s.dw, s.dh);
          // Highlight the centre cell.
          const cell = side / LOUPE_GRID;
          const mid = Math.floor(LOUPE_GRID / 2) * cell;
          ctx.lineWidth = Math.max(1, Math.round(dpr));
          ctx.strokeStyle = '#ffffff';
          ctx.strokeRect(mid + 0.5, mid + 0.5, cell - 1, cell - 1);
          ctx.strokeStyle = '#000000';
          ctx.strokeRect(mid - 0.5, mid - 0.5, cell + 1, cell + 1);
        }
        if (loupeCoordsRef.current) loupeCoordsRef.current.textContent = `${px}, ${py}`;
      } else {
        lp.style.display = 'none';
      }
    }
  }, []);

  const schedule = useCallback(() => {
    const st = live.current;
    if (st.raf === null) st.raf = requestAnimationFrame(draw);
  }, [draw]);

  // ---- actions ------------------------------------------------------------------------------

  const cancel = useCallback(() => {
    const st = live.current;
    if (st.busy) return;
    void ipc.captureCancel().catch(() => undefined);
  }, []);

  const commitRegion = useCallback(
    async (rectCss: Box) => {
      const st = live.current;
      const info = st.info;
      const img = frameRef.current;
      if (!info || !img || st.busy) return;
      const rect = cssRectToPhysical(rectCss, info.scale, img.naturalWidth, img.naturalHeight);
      if (rect.w < 1 || rect.h < 1) return;
      st.busy = true;
      try {
        await ipc.captureCommit({ kind: 'region', monitor: info.monitor, rect });
      } catch (e) {
        st.busy = false;
        st.dragging = false;
        st.anchor = null;
        setDragging(false);
        setError(errorMessage(e));
        schedule();
      }
    },
    [schedule],
  );

  const commitWindow = useCallback(
    async (win: WindowInfo) => {
      const st = live.current;
      if (st.busy) return;
      st.busy = true;
      try {
        await ipc.captureCommit({ kind: 'window', hwnd: win.hwnd });
      } catch (e) {
        st.busy = false;
        setError(errorMessage(e));
      }
    },
    [],
  );

  const toggleMode = useCallback(() => {
    const st = live.current;
    if (st.purpose !== 'capture') return; // scroll captures pick a window, GIFs pick a region
    const next: CaptureMode = st.mode === 'region' ? 'window' : 'region';
    st.mode = next;
    st.dragging = false;
    st.anchor = null;
    setDragging(false);
    setMode(next);
    void ipc.overlaySetMode(next).catch(() => undefined);
    if (next === 'window' && st.info && st.cursor) {
      st.hover = hitTestWindow(st.info.windows, st.info.bounds, st.info.scale, st.cursor);
    }
    schedule();
  }, [schedule]);

  const commitEnter = useCallback(() => {
    const st = live.current;
    const info = st.info;
    if (!info || st.busy) return;
    if (st.mode === 'window') {
      if (st.hover) void commitWindow(st.hover);
      return;
    }
    if (st.dragging && st.anchor && st.cursor) {
      void commitRegion(normalizeRect(st.anchor, st.cursor));
      return;
    }
    // Nothing selected: Enter captures the whole monitor.
    const img = frameRef.current;
    if (img) {
      void commitRegion({ x: 0, y: 0, w: img.naturalWidth / info.scale, h: img.naturalHeight / info.scale });
    }
  }, [commitRegion, commitWindow]);

  // ---- arming from Rust ---------------------------------------------------------------------

  const arm = useCallback(
    async (payload: ArmPayload) => {
      const st = live.current;
      st.nonce = payload.nonce;
      st.mode = payload.mode;
      st.purpose = payload.purpose;
      st.cursor = null;
      st.anchor = null;
      st.dragging = false;
      st.hover = null;
      st.busy = false;
      st.focusRequested = false;
      setMode(payload.mode);
      setPurpose(payload.purpose);
      setArmCount((n) => n + 1);
      setDragging(false);
      setError(null);
      try {
        const info = await ipc.overlayInfo();
        if (live.current.nonce !== payload.nonce) return; // superseded by a newer arm
        st.info = info;
        const img = frameRef.current;
        if (!img) return;
        const t0 = performance.now();
        img.src = frameUrl(info.monitor, payload.nonce);
        await img.decode();
        const decodeMs = performance.now() - t0;
        if (live.current.nonce !== payload.nonce) return;
        if (payload.cursor) {
          const cx = (payload.cursor.x - info.bounds.x) / info.scale;
          const cy = (payload.cursor.y - info.bounds.y) / info.scale;
          if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
            st.cursor = { x: cx, y: cy };
            if (st.mode === 'window') {
              st.hover = hitTestWindow(info.windows, info.bounds, info.scale, st.cursor);
            }
          }
        }
        draw();
        await ipc.overlayReady(payload.nonce, decodeMs);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [draw],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      void p.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    keep(events.onOverlayArm((p) => void arm(p)));
    keep(
      events.onOverlayMode((m) => {
        const st = live.current;
        if (st.mode === m) return;
        st.mode = m;
        st.dragging = false;
        st.anchor = null;
        setDragging(false);
        setMode(m);
        if (m === 'window' && st.info && st.cursor) {
          st.hover = hitTestWindow(st.info.windows, st.info.bounds, st.info.scale, st.cursor);
        }
        schedule();
      }),
    );
    // An overlay that finished loading after the hotkey fired (e.g. just rebuilt after a monitor
    // change) misses the arm event; catch up from the session state instead.
    void ipc
      .overlayInfo()
      .then((info) => {
        if (!cancelled && live.current.nonce === 0) {
          void arm({ nonce: info.nonce, mode: info.mode, purpose: info.purpose, cursor: null });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
    };
  }, [arm, schedule]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) toggleMode();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commitEnter();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, toggleMode, commitEnter]);

  // ---- pointer handling ---------------------------------------------------------------------

  const localPoint = (e: React.PointerEvent): Point =>
    clampPoint({ x: e.clientX, y: e.clientY }, window.innerWidth, window.innerHeight);

  const onPointerMove = (e: React.PointerEvent) => {
    const st = live.current;
    if (!st.info || st.busy) return;
    if (!st.focusRequested && !document.hasFocus()) {
      st.focusRequested = true;
      void ipc.overlayFocus().catch(() => undefined);
    }
    const p = localPoint(e);
    st.cursor = p;
    if (st.mode === 'window') {
      st.hover = hitTestWindow(st.info.windows, st.info.bounds, st.info.scale, p);
    }
    schedule();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const st = live.current;
    if (!st.info || st.busy) return;
    if (e.button === 2) {
      cancel();
      return;
    }
    if (e.button !== 0) return;
    const p = localPoint(e);
    st.cursor = p;
    if (st.mode === 'window') {
      const hit = hitTestWindow(st.info.windows, st.info.bounds, st.info.scale, p);
      if (hit) void commitWindow(hit);
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    st.anchor = p;
    st.dragging = true;
    setDragging(true);
    schedule();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const st = live.current;
    if (!st.dragging || !st.anchor) return;
    const p = localPoint(e);
    st.cursor = p;
    const rect = normalizeRect(st.anchor, p);
    st.dragging = false;
    setDragging(false);
    if (rect.w >= MIN_DRAG_PX && rect.h >= MIN_DRAG_PX) {
      void commitRegion(rect);
    } else {
      st.anchor = null; // a click without a drag selects nothing
    }
    schedule();
  };

  return (
    <div
      className="ov-root"
      role="application"
      aria-label="Screen capture"
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <img ref={frameRef} className="ov-frame" alt="" draggable={false} />
      <div ref={dimRef} className="ov-dim" />
      <div ref={selRef} className="ov-sel" style={{ display: 'none' }} />
      <div ref={vLineRef} className="ov-line ov-line-v" style={{ display: 'none' }} />
      <div ref={hLineRef} className="ov-line ov-line-h" style={{ display: 'none' }} />
      <div ref={winLabelRef} className="ov-chip ov-win-label" style={{ display: 'none' }} />
      <div ref={readoutRef} className="ov-chip mono ov-readout" style={{ display: 'none' }} />
      <div ref={loupeRef} className="ov-loupe" style={{ display: 'none' }}>
        <canvas ref={loupeCanvasRef} className="ov-loupe-canvas" />
        <div className="ov-chip mono ov-loupe-coords">
          <span ref={loupeCoordsRef} />
        </div>
      </div>
      {!dragging && (
        <div key={armCount} className="ov-hint" aria-live="polite">
          {purpose === 'scroll' ? (
            <>
              <span>Click the window to scroll-capture</span>
              <kbd>Esc</kbd>
              <span>cancel</span>
            </>
          ) : purpose === 'gif' ? (
            <>
              <span>Drag the area to record</span>
              <kbd>Enter</kbd>
              <span>full screen</span>
              <kbd>Esc</kbd>
              <span>cancel</span>
            </>
          ) : mode === 'region' ? (
            <>
              <span>Drag to capture</span>
              <kbd>Space</kbd>
              <span>window</span>
              <kbd>Enter</kbd>
              <span>full screen</span>
              <kbd>Esc</kbd>
              <span>cancel</span>
            </>
          ) : (
            <>
              <span>Click a window</span>
              <kbd>Space</kbd>
              <span>region</span>
              <kbd>Esc</kbd>
              <span>cancel</span>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="ov-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
