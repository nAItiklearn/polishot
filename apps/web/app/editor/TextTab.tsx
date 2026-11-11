'use client';

import { wordsToText } from '@polishot/editor/react';
import { ScanText } from 'lucide-react';
import { useId, useMemo } from 'react';
import { STAGE_LABEL, type useOcr } from './useOcr';

type Ocr = ReturnType<typeof useOcr>;

/** Progress and errors for text recognition. It never blocks the editor: the canvas stays usable. */
export function OcrStatus({ ocr, className }: { ocr: Ocr; className?: string }) {
  if (ocr.status === 'running') {
    return (
      <div className={`ed-ocr ${className ?? ''}`} data-testid="ocr-progress">
        <div className="ed-ocr-row">
          <span>{STAGE_LABEL[ocr.stage]}</span>
          <span className="pe-value">{Math.round(ocr.progress * 100)}%</span>
        </div>
        <progress className="ed-progress" value={ocr.progress} max={1} aria-label="Text recognition progress" />
        <p className="pe-hint">Runs on this device. You can keep editing.</p>
      </div>
    );
  }
  if (ocr.status === 'error') {
    return (
      <p className={`pe-error ${className ?? ''}`} role="alert">
        {ocr.error}
        {ocr.blocked && (
          <>
            {' '}
            <button type="button" className="ed-link" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </>
        )}
      </p>
    );
  }
  return null;
}

/** Recognised text: find it, then select it on the image or read it here. */
export function TextTab({ ocr, onFind }: { ocr: Ocr; onFind: () => void }) {
  const titleId = useId();
  const words = ocr.words;
  const text = useMemo(() => (words && words.length > 0 ? wordsToText(words) : ''), [words]);

  return (
    <section className="pe-section" aria-labelledby={titleId}>
      <div className="pe-section-head">
        <h3 className="pe-section-title" id={titleId}>
          Text in the image
        </h3>
        {words && words.length > 0 && (
          <span className="pe-count" data-testid="word-count">
            {words.length} {words.length === 1 ? 'word' : 'words'}
          </span>
        )}
      </div>
      <div className="pe-section-body">
        <OcrStatus ocr={ocr} />

        {(ocr.status === 'idle' || ocr.status === 'error') && (
          <>
            <p className="pe-hint">Find the text in this screenshot to select it on the image or copy all of it.</p>
            <button type="button" className="pe-btn pe-btn-wide" onClick={onFind}>
              <ScanText size={16} strokeWidth={1.5} aria-hidden="true" />
              {ocr.status === 'error' ? 'Try again' : 'Find text'}
            </button>
          </>
        )}

        {ocr.status === 'done' && words && words.length === 0 && (
          <p className="pe-hint">No text was found in this image.</p>
        )}

        {ocr.status === 'done' && words && words.length > 0 && (
          <>
            <p className="pe-hint">Select text on the image, or use Copy all text.</p>
            <pre className="ed-textpreview" tabIndex={0} aria-label="Recognised text" data-testid="ocr-text">
              {text}
            </pre>
          </>
        )}
      </div>
    </section>
  );
}
