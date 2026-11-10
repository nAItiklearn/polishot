import { Copy, Download, LoaderCircle, Share2, X } from 'lucide-react';

export type TopAction = 'copy' | 'save' | 'share';

export interface TopBarProps {
  /** The action in flight, if any. Its icon becomes a spinner only if it takes longer than 300 ms. */
  busy: TopAction | null;
  disabled: boolean;
  onClose: () => void;
  onShare: () => void;
  onSave: () => void;
  onCopy: () => void;
}

/**
 * Close on the left; Share, Save and Copy on the right. Copy is the one accent-coloured control at rest (the
 * primary action); everything else is quiet. Every target is 48 dp. Floats over the canvas so the artboard keeps
 * the whole screen.
 */
export function TopBar({ busy, disabled, onClose, onShare, onSave, onCopy }: TopBarProps) {
  const off = disabled || busy !== null;
  return (
    <header className="eh-top">
      <button type="button" className="eh-iconbtn" aria-label="Close" onClick={onClose}>
        <X size={20} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <div className="eh-spacer" />
      <button type="button" className="eh-iconbtn" aria-label="Share" disabled={off} onClick={onShare}>
        {busy === 'share' ? <Spinner /> : <Share2 size={20} strokeWidth={1.5} aria-hidden="true" />}
      </button>
      <button type="button" className="eh-iconbtn" aria-label="Save to gallery" disabled={off} onClick={onSave}>
        {busy === 'save' ? <Spinner /> : <Download size={20} strokeWidth={1.5} aria-hidden="true" />}
      </button>
      <button type="button" className="eh-primary" disabled={off} onClick={onCopy}>
        {busy === 'copy' ? <Spinner /> : <Copy size={18} strokeWidth={1.5} aria-hidden="true" />}
        <span>Copy</span>
      </button>
    </header>
  );
}

/** Rotating glyph that only becomes visible after 300 ms, so quick actions never flash a spinner. */
function Spinner() {
  return <LoaderCircle size={20} strokeWidth={1.5} className="eh-spin" aria-hidden="true" />;
}
