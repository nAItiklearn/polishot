'use client';

import { ImagePlus, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  busy: boolean;
  onChoose: () => void;
  onSample: () => void;
  /** Called on hover, focus and touch so the editor code can start downloading before the click. */
  onIntent: () => void;
}

/** What the editor shows before there is an image: a drop target, two ways in, and one line on privacy. */
export function EmptyState({ busy, onChoose, onSample, onIntent }: EmptyStateProps) {
  const intent = { onPointerEnter: onIntent, onFocus: onIntent, onTouchStart: onIntent };
  return (
    <div className="ed-empty" data-testid="editor-dropzone">
      <div className="ed-empty-inner">
        <span className="ed-empty-icon">
          <ImagePlus size={20} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <h2 className="ed-empty-title display-3">
          Drop a <em>screenshot</em>
        </h2>
        <p className="ed-empty-lede">Or paste one with Ctrl+V. PNG, JPEG or WebP, up to 25 MB.</p>
        <div className="ed-empty-actions">
          <Button type="button" className="btn-ember rounded-xl font-semibold" disabled={busy} onClick={onChoose} {...intent}>
            Choose image
          </Button>
          <Button type="button" variant="outline" className="rounded-xl" disabled={busy} onClick={onSample} {...intent}>
            Try the sample
          </Button>
        </div>
        <p className="ed-privacy">
          <Lock size={14} strokeWidth={1.5} aria-hidden="true" />
          Runs in your browser. Nothing is uploaded.
        </p>
      </div>
    </div>
  );
}
