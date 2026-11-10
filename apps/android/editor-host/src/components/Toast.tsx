import { AlertCircle, Check } from 'lucide-react';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastState {
  id: number;
  kind: 'ok' | 'error';
  message: string;
  action?: ToastAction;
}

/** A calm, short-lived confirmation ("Image copied"), optionally with one action such as Undo. */
export function Toast({ toast, onDone }: { toast: ToastState | null; onDone: () => void }) {
  return (
    <div className="eh-toast-region" role="status" aria-live="polite">
      {toast && (
        <div className="eh-toast" data-kind={toast.kind} key={toast.id}>
          {toast.kind === 'ok' ? (
            <Check size={16} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <AlertCircle size={16} strokeWidth={1.5} aria-hidden="true" />
          )}
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="eh-toast-action"
              onClick={() => {
                toast.action?.run();
                onDone();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
