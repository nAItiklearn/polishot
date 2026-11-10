import { X } from 'lucide-react';
import type { Toast } from '../context';
import { cx } from '../lib/format';

/**
 * Quiet notifications at the top of the window. Each is a polite live region (errors are assertive),
 * so a screen reader hears "Copied" without focus moving.
 */
export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pv-toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={cx('pv-toast', t.tone === 'error' && 'pv-toast-error')} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span className="pv-toast-msg">{t.message}</span>
          {t.action ? (
            <button
              type="button"
              className="pv-toast-action"
              onClick={() => {
                t.action?.run();
                onDismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" className="pv-toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(t.id)}>
            <X size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
