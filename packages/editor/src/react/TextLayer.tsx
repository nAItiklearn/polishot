import { groupLines, type OcrWord } from '@polishot/redact';
import { Check, Copy } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import type { Editor } from '../editor';
import { useEditorVersion } from './hooks';

export interface TextLayerProps {
  editor: Editor;
  /** OCR words in source-image pixels. */
  words: OcrWord[] | null | undefined;
  /** Override how text reaches the clipboard (the desktop host uses a native command). */
  onCopyText?: (text: string) => void | Promise<void>;
  className?: string;
}

/** Reading-order text of OCR words: words joined by spaces, lines by newlines. */
export function wordsToText(words: readonly OcrWord[]): string {
  return groupLines([...words])
    .map((line) => line.map((w) => w.text).join(' '))
    .join('\n');
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to the legacy path (older WebViews, or no clipboard permission).
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    ta.remove();
  }
}

/**
 * Transparent, selectable text over the screenshot. Each OCR word is an absolutely positioned span (never
 * parsed as HTML), stretched to the word's box, so native drag-select and Ctrl+C work. The layer takes
 * pointer events only while the select tool has nothing selected, so it never gets in the way of drawing.
 */
export function TextLayer({ editor, words, onCopyText, className }: TextLayerProps) {
  useEditorVersion(editor);
  const rootRef = useRef<HTMLDivElement>(null);
  const spans = useRef<(HTMLSpanElement | null)[]>([]);
  const [copied, setCopied] = useState(false);

  const crop = editor.doc.crop;
  const visible = useMemo(() => {
    const list = (words ?? []).filter((w) => w && typeof w.text === 'string' && w.text.length > 0);
    if (!crop) return list;
    return list.filter((w) => {
      const cx = w.box.x + w.box.w / 2;
      const cy = w.box.y + w.box.h / 2;
      return cx >= crop.x && cx <= crop.x + crop.w && cy >= crop.y && cy <= crop.y + crop.h;
    });
  }, [words, crop]);

  const active = editor.tool === 'select' && editor.selectedId === null && !!words?.length;
  const rects = visible.map((w) => editor.imageRectToScreen(w.box));

  // Stretch each word horizontally so its selection highlight matches the word on screen.
  useLayoutEffect(() => {
    visible.forEach((w, i) => {
      const el = spans.current[i];
      if (!el) return;
      const r = rects[i]!;
      el.style.transform = '';
      const natural = el.offsetWidth;
      if (natural > 0 && r.w > 0) el.style.transform = `scaleX(${(r.w / natural).toFixed(4)})`;
      void w;
    });
  });

  const onCopy = (e: ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !rootRef.current) return;
    const picked: OcrWord[] = [];
    visible.forEach((w, i) => {
      const el = spans.current[i];
      if (el && sel.containsNode(el, true)) picked.push(w);
    });
    if (picked.length === 0) return;
    e.clipboardData.setData('text/plain', wordsToText(picked));
    e.preventDefault();
  };

  const copyAll = async () => {
    const text = wordsToText(visible);
    if (!text) return;
    if (onCopyText) await onCopyText(text);
    else await writeClipboard(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  if (!words || words.length === 0) return null;
  return (
    <>
      <div
        ref={rootRef}
        className={`pe-textlayer ${className ?? ''}`}
        data-active={active}
        role="group"
        aria-label="Recognised text"
        onCopy={onCopy}
      >
        {visible.map((w, i) => {
          const r = rects[i]!;
          return (
            <span
              key={i}
              ref={(el) => {
                spans.current[i] = el;
              }}
              className="pe-word"
              style={{
                left: r.x,
                top: r.y,
                height: r.h,
                fontSize: Math.max(4, r.h * 0.8),
                lineHeight: `${r.h}px`,
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
      <div className="pe-textactions">
        <button type="button" className="pe-btn pe-btn-float" onClick={() => void copyAll()}>
          {copied ? <Check size={16} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.5} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy all text'}
        </button>
        <span className="pe-visually-hidden" role="status" aria-live="polite">
          {copied ? 'Text copied to the clipboard' : ''}
        </span>
      </div>
    </>
  );
}
