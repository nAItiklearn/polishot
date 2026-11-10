import type { Editor } from '@polishot/editor';
import { useEditorVersion } from '@polishot/editor/react';
import { detect, type OcrWord } from '@polishot/redact';
import { EyeOff, ScanText } from 'lucide-react';
import { useMemo } from 'react';

export interface ChipsProps {
  editor: Editor;
  /** null while recognition is still running. */
  words: OcrWord[] | null;
  /** Hide the chips while the screenshot is loading or a batch is running. */
  suppressed: boolean;
  onCopyText: () => void;
  /** Called after "N found" hid everything, with the number hidden (the host shows an undo toast). */
  onHidden: (count: number) => void;
}

/**
 * Two small chips under the top bar, never a dialog:
 *  - "Copy text": all recognised text on the clipboard in one tap;
 *  - "3 found": sensitive items (emails, cards, IP addresses, tokens) were detected; one tap hides them all.
 * Fine control stays in the Redact tab.
 */
export function Chips({ editor, words, suppressed, onCopyText, onHidden }: ChipsProps) {
  useEditorVersion(editor);
  const detections = useMemo(() => (words && words.length > 0 ? detect(words) : []), [words]);
  const pending = detections.filter((d) => !editor.isDetectionApplied(d));

  const showFound = !suppressed && pending.length > 0;
  const showText = !suppressed && words !== null && words.length > 0;
  if (!showFound && !showText) return null;

  return (
    <div className="eh-chips">
      {showText && (
        <button type="button" className="eh-chip" onClick={onCopyText}>
          <ScanText size={16} strokeWidth={1.5} aria-hidden="true" />
          <span>Copy text</span>
        </button>
      )}
      {showFound && (
        <button
          type="button"
          className="eh-chip"
          aria-label={`${pending.length} sensitive ${pending.length === 1 ? 'item' : 'items'} found. Hide`}
          onClick={() => {
            const count = pending.length;
            editor.applyDetections(detections, 'blur');
            onHidden(count);
          }}
        >
          <EyeOff size={16} strokeWidth={1.5} aria-hidden="true" />
          <span>{pending.length} found</span>
        </button>
      )}
    </div>
  );
}
