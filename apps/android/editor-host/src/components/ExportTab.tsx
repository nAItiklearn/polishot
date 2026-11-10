import type { Editor } from '@polishot/editor';
import { ExportPanel, type ExportResult } from '@polishot/editor/react';
import { Send, Share2 } from 'lucide-react';
import { useState } from 'react';
import type { ExportDefaults } from '../payload';

export interface ExportTabProps {
  editor: Editor;
  defaults: ExportDefaults;
  quickSendAvailable: boolean;
  /** Save or copy, from the shared ExportPanel. */
  onExport: (result: ExportResult) => void | Promise<void>;
  /** Share sheet and quick send render their own image with the default format. */
  onShare: () => Promise<void>;
  onQuickSend: () => Promise<void>;
}

/**
 * The shared ExportPanel (format, scale, quality, Save image, Copy image) plus the two actions that only exist on
 * the phone: the system share sheet and quick send to a paired PC (shown only when it is available).
 */
export function ExportTab({ editor, defaults, quickSendAvailable, onExport, onShare, onQuickSend }: ExportTabProps) {
  const [busy, setBusy] = useState<'share' | 'send' | null>(null);

  const run = async (which: 'share' | 'send', action: () => Promise<void>) => {
    if (busy) return;
    setBusy(which);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="eh-exporttab">
      <ExportPanel editor={editor} onExport={onExport} defaults={defaults} actions={['save', 'copy']} />
      <section className="pe-section">
        <div className="pe-actions">
          <button type="button" className="pe-btn" disabled={busy !== null} onClick={() => void run('share', onShare)}>
            <Share2 size={16} strokeWidth={1.5} aria-hidden="true" />
            {busy === 'share' ? 'Preparing…' : 'Share'}
          </button>
          {quickSendAvailable && (
            <button type="button" className="pe-btn" disabled={busy !== null} onClick={() => void run('send', onQuickSend)}>
              <Send size={16} strokeWidth={1.5} aria-hidden="true" />
              {busy === 'send' ? 'Sending…' : 'Send to PC'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
