import { detect, type DetectionKind, type OcrWord } from '@polishot/redact';
import { ScanSearch } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Editor } from '../editor';
import { maskPreview } from '../mask';
import { useEditorVersion } from './hooks';
import { Section } from './ui';

export interface RedactPanelProps {
  editor: Editor;
  /** OCR words in source-image pixels. Null/undefined until the host has run OCR. */
  words: OcrWord[] | null | undefined;
  /** Called by the "Find sensitive data" button; the host runs OCR and updates `words`. */
  onScan?: () => void | Promise<void>;
  scanning?: boolean;
  kinds?: DetectionKind[];
  className?: string;
}

/**
 * Lists sensitive data found in the OCR words (emails, cards, IPs, tokens) as toggleable rows with a masked
 * preview, plus one-click "Blur all" and "Bars". Detection runs locally; nothing is sent anywhere.
 */
export function RedactPanel({ editor, words, onScan, scanning, kinds, className }: RedactPanelProps) {
  useEditorVersion(editor);
  const [mode, setMode] = useState<'blur' | 'bar'>('blur');
  const dets = useMemo(() => (words && words.length ? detect(words, { kinds }) : []), [words, kinds]);
  const applied = dets.filter((d) => editor.isDetectionApplied(d));
  const scanned = Array.isArray(words);

  return (
    <div className={`pe-redact ${className ?? ''}`}>
      <Section
        title="Sensitive data"
        aside={
          scanned ? (
            <span className="pe-count" aria-live="polite">
              {dets.length === 0 ? 'None found' : `${dets.length} found`}
            </span>
          ) : null
        }
      >
        {!scanned && (
          <button type="button" className="pe-btn pe-btn-wide" disabled={scanning || !onScan} onClick={() => void onScan?.()}>
            <ScanSearch size={16} strokeWidth={1.5} aria-hidden="true" />
            {scanning ? 'Scanning…' : 'Find sensitive data'}
          </button>
        )}

        {scanned && dets.length === 0 && <p className="pe-hint">Nothing sensitive was found in the recognised text.</p>}

        {dets.length > 0 && (
          <>
            <ul className="pe-detlist">
              {dets.map((d) => {
                const on = editor.isDetectionApplied(d);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      className="pe-detrow"
                      onClick={() => (on ? editor.removeDetections([d]) : editor.applyDetections([d], mode))}
                    >
                      <span className="pe-switch" aria-hidden="true" />
                      <span className="pe-detmain">
                        <span className="pe-detlabel">{d.label}</span>
                        <span className="pe-detmask">{maskPreview(d.kind, d.value)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="pe-actions">
              <button
                type="button"
                className="pe-btn pe-btn-primary"
                onClick={() => {
                  setMode('blur');
                  editor.applyDetections(dets, 'blur');
                }}
              >
                Blur all
              </button>
              <button
                type="button"
                className="pe-btn"
                onClick={() => {
                  setMode('bar');
                  editor.applyDetections(dets, 'bar');
                }}
              >
                Bars
              </button>
              {applied.length > 0 && (
                <button type="button" className="pe-btn pe-btn-quiet" onClick={() => editor.removeDetections(dets)}>
                  Clear
                </button>
              )}
            </div>
            <p className="pe-hint" aria-live="polite">
              {applied.length} of {dets.length} hidden
            </p>
          </>
        )}
      </Section>
    </div>
  );
}
