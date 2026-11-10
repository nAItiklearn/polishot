import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Modal focus handling shared by dialogs: remember what had focus, trap Tab inside `ref`, close on
 * Escape, and hand focus back on close.
 */
export function useModal(open: boolean, onClose: () => void, initialFocus: () => HTMLElement | null) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const initialRef = useRef(initialFocus);
  initialRef.current = initialFocus;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Wait a frame so the dialog is in the DOM and laid out before focusing.
    const raf = requestAnimationFrame(() => initialRef.current()?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !ref.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture phase so the app's own Escape handling (hide the window) never sees this keypress.
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [open]);

  return ref;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A confirmation for something that cannot be undone. Focus starts on Cancel, the safe choice. */
export function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel = 'Cancel', busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const ref = useModal(open, onCancel, () => cancelRef.current);
  if (!open) return null;
  return createPortal(
    <div className="pv-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div ref={ref} className="pv-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}>
        <h2 className="pv-dialog-title" id={titleId}>
          {title}
        </h2>
        <p className="pv-dialog-body" id={bodyId}>
          {body}
        </p>
        <div className="pv-dialog-actions">
          <button ref={cancelRef} type="button" className="pe-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="pe-btn pe-btn-primary" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
