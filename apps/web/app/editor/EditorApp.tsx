'use client';

/**
 * The /editor shell. It is the only code the first load needs: a drop target, a file picker, paste, and
 * the "Try the sample" button. The editor itself (Konva, the toolbar and inspector) lives in ./Workspace
 * and is downloaded the moment someone shows intent (hover, focus, drop, paste) or opens an image.
 * Text recognition is loaded later still, only when it is asked for.
 *
 * Everything runs in the tab. Files are decoded with createImageBitmap and never uploaded.
 */
import { X } from 'lucide-react';
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import './shell.css';
import { EmptyState } from './EmptyState';
import { loadedAsEditorRoute, reloadOnce } from './csp';
import { ACCEPT_ATTR, ImageError, loadImageFile, type LoadedImage } from './image';
import { loadSample } from './sample';
import { isTextEntry } from './textEntry';

const importWorkspace = () => import('./Workspace');
const Workspace = lazy(importWorkspace);
const prefetchWorkspace = () => {
  void importWorkspace().catch(() => undefined);
};

type NoticeKind = 'info' | 'error';
interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
}
export type Notify = (text: string, kind?: NoticeKind) => void;

const NOTICE_MS: Record<NoticeKind, number> = { info: 3200, error: 10_000 };

/** Shows a plain sentence instead of a blank screen if the editor code fails to load or crashes. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="ed-opening" role="alert">
        <p>
          The editor could not load. Check your connection and{' '}
          <button type="button" className="link-quiet" onClick={() => window.location.reload()}>
            reload the page
          </button>
          .
        </p>
      </div>
    );
  }
}

/** Tracks the sticky site header so the app fills exactly the rest of the viewport. */
function useHeaderOffset(root: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = root.current;
    const header = document.querySelector('body > header');
    if (!el || !header) return;
    const apply = () => el.style.setProperty('--ed-top', `${Math.round(header.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(header);
    return () => ro.disconnect();
  }, [root]);
}

export default function EditorApp() {
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const loadSeq = useRef(0);
  const noticeSeq = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useHeaderOffset(rootRef);

  // The Content-Security-Policy belongs to the document the browser loaded. Arriving here through a client-side
  // link from another page keeps that page's stricter policy (no blob workers, no WebAssembly), which blocks
  // text recognition, so load /editor fresh once. There is nothing to lose yet: no image is open.
  useEffect(() => {
    if (loadedAsEditorRoute() === false) reloadOnce();
  }, []);

  const dismiss = useCallback(() => {
    clearTimeout(noticeTimer.current);
    setNotice(null);
  }, []);

  const notify = useCallback<Notify>((text, kind = 'info') => {
    clearTimeout(noticeTimer.current);
    const id = ++noticeSeq.current;
    setNotice({ id, kind, text });
    noticeTimer.current = setTimeout(() => setNotice((n) => (n?.id === id ? null : n)), NOTICE_MS[kind]);
  }, []);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  /** Runs a loader; only the most recent request may win, and a superseded bitmap is released. */
  const open = useCallback(
    async (load: () => Promise<LoadedImage>) => {
      const mine = ++loadSeq.current;
      setBusy(true);
      prefetchWorkspace();
      try {
        const next = await load();
        if (mine !== loadSeq.current) {
          next.bitmap.close();
          return;
        }
        dismiss();
        setImage(next);
      } catch (err) {
        if (mine === loadSeq.current) {
          notify(err instanceof ImageError ? err.message : 'That image could not be opened. Try another file.', 'error');
        }
      } finally {
        if (mine === loadSeq.current) setBusy(false);
      }
    },
    [dismiss, notify],
  );

  const openFile = useCallback(
    (file: File | null | undefined, origin: LoadedImage['origin'] = 'file') => {
      if (file) void open(() => loadImageFile(file, origin));
    },
    [open],
  );
  const openSample = useCallback(() => void open(loadSample), [open]);
  const choose = useCallback(() => input.current?.click(), []);

  // Paste an image from the clipboard anywhere on the page (but never into a text field).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTextEntry(e.target)) return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      openFile(file, 'paste');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [openFile]);

  // Start fetching the editor once the page has settled, so the first click is instant.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    let id: number | undefined;
    const timer = window.setTimeout(() => {
      id = idle(prefetchWorkspace) as number;
    }, 2500);
    return () => {
      window.clearTimeout(timer);
      if (id !== undefined) cancel(id);
    };
  }, []);

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    prefetchWorkspace();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    openFile(e.dataTransfer.files[0]);
  };

  return (
    <div
      ref={rootRef}
      className="ed-app"
      data-testid="editor-app"
      data-state={image ? 'ready' : 'empty'}
      data-dragging={dragging}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={input}
        type="file"
        accept={ACCEPT_ATTR}
        hidden
        aria-label="Choose an image"
        onChange={(e) => {
          openFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {image ? (
        <Boundary>
          <Suspense
            fallback={
              <div className="ed-opening" aria-hidden="true">
                Opening
              </div>
            }
          >
            <Workspace image={image} onChooseFile={choose} notify={notify} />
          </Suspense>
        </Boundary>
      ) : (
        <EmptyState busy={busy} onChoose={choose} onSample={openSample} onIntent={prefetchWorkspace} />
      )}

      {dragging && (
        <div className="ed-drop" aria-hidden="true">
          Drop to open
        </div>
      )}

      <div className="ed-toast" role="status" aria-live="polite" data-empty={notice === null} data-kind={notice?.kind} data-testid="editor-notice">
        {notice && (
          <>
            <span className="ed-toast-text">{notice.text}</span>
            <button type="button" className="ed-toast-close" aria-label="Dismiss message" onClick={dismiss}>
              <X size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
