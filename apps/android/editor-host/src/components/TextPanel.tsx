import type { OcrWord } from '@polishot/redact';
import { wordsToText } from '@polishot/editor/react';
import { Copy } from 'lucide-react';
import { useMemo } from 'react';

export interface TextPanelProps {
  /** null while recognition is still running. */
  words: OcrWord[] | null;
  onCopy: (text: string) => void;
}

/** The recognised text in reading order, with one-tap copy. Long-press on the screenshot selects single words. */
export function TextPanel({ words, onCopy }: TextPanelProps) {
  const text = useMemo(() => (words && words.length > 0 ? wordsToText(words) : ''), [words]);

  if (words === null) {
    return (
      <section className="pe-section" aria-live="polite">
        <p className="pe-hint">Reading the text in your screenshot…</p>
      </section>
    );
  }
  if (text === '') {
    return (
      <section className="pe-section">
        <p className="pe-hint">No text was found in this screenshot.</p>
      </section>
    );
  }
  return (
    <section className="pe-section eh-textpanel">
      <div className="pe-actions">
        <button type="button" className="pe-btn pe-btn-primary" onClick={() => onCopy(text)}>
          <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
          Copy all text
        </button>
      </div>
      <pre className="eh-ocrtext" tabIndex={0} aria-label="Recognised text">
        {text}
      </pre>
      <p className="pe-hint">Touch and hold on the screenshot to select single words.</p>
    </section>
  );
}
