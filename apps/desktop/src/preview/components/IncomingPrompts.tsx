import { Smartphone } from 'lucide-react';
import type { IncomingFile } from '../../shared/ipc';
import { incomingSummary } from '../lib/quicksend';

export interface IncomingPromptsProps {
  prompts: readonly IncomingFile[];
  onRespond: (requestId: number, accept: boolean) => void;
}

/**
 * "Pixel 8 wants to send you an image": a card per request, Decline or Accept. They stay until
 * answered (the backend declines after 55 s) instead of fading like a toast, and they never take
 * focus, so a prompt cannot swallow a keystroke meant for the editor.
 */
export function IncomingPrompts({ prompts, onRespond }: IncomingPromptsProps) {
  if (prompts.length === 0) return null;
  return (
    <div className="pv-incoming" role="region" aria-label="Incoming images">
      {prompts.map((p) => (
        <div key={p.requestId} className="pv-incoming-card" role="alert">
          <Smartphone size={16} strokeWidth={1.5} aria-hidden="true" />
          <div className="pv-incoming-text">
            <p className="pv-incoming-title">{p.peerName} wants to send you an image</p>
            <p className="pv-incoming-sub">{incomingSummary(p)}</p>
          </div>
          <div className="pv-incoming-actions">
            <button type="button" className="pe-btn" onClick={() => onRespond(p.requestId, false)}>
              Decline
            </button>
            <button type="button" className="pe-btn pe-btn-primary" onClick={() => onRespond(p.requestId, true)}>
              Accept
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
