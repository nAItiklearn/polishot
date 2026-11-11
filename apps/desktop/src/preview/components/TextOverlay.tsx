import type { Editor } from '@polishot/editor';
import { wordsToText } from '@polishot/editor/react';
import type { OcrWord } from '@polishot/redact';
import { memo, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';

export interface TextOverlayProps {
  editor: Editor;
  /** OCR words in source-image pixels. */
  words: OcrWord[] | null | undefined;
}

type Crop = { x: number; y: number; w: number; h: number } | null;

const sameCrop = (a: Crop, b: Crop): boolean =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/**
 * Transparent, selectable text over the screenshot (drag across it, Ctrl+C copies the words in reading order).
 *
 * It does what the editor package's `TextLayer` does, with the cost moved out of the frame loop. The package
 * component re-renders on every editor event and, for every word, resets and re-reads its width, which forces a
 * layout per word per frame: with a screenful of text that is most of a frame during a slider drag. Here:
 * - the words live in source-image pixels inside one stage, so following the canvas (padding, zoom, resize) is a
 *   single `transform` on the stage, written straight from the editor's events with no React render;
 * - each word's width is measured once per set of words (reads batched, then writes) and kept;
 * - React only re-renders when the words or the crop change (the component is memoised, so the editor view
 *   re-rendering around it on every frame does not touch the words).
 * The classes (`pe-textlayer`, `pe-word`) and the group role are the package's, so styling and tests carry over.
 */
export const TextOverlay = memo(function TextOverlay({ editor, words }: TextOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [crop, setCrop] = useState<Crop>(editor.doc.crop);

  const visible = useMemo(() => {
    const list = (words ?? []).filter((w) => w && typeof w.text === 'string' && w.text.length > 0);
    if (!crop) return list;
    return list.filter((w) => {
      const cx = w.box.x + w.box.w / 2;
      const cy = w.box.y + w.box.h / 2;
      return cx >= crop.x && cx <= crop.x + crop.w && cy >= crop.y && cy <= crop.y + crop.h;
    });
  }, [words, crop]);
  const hasWords = visible.length > 0;

  // Follow the canvas without rendering: the stage maps source pixels to screen pixels with one transform, and the
  // layer takes pointer events only while Select has nothing selected (it must never get in the way of drawing).
  useLayoutEffect(() => {
    const sync = () => {
      const stage = stageRef.current;
      const root = rootRef.current;
      if (!stage || !root) return;
      const r = editor.imageRectToScreen({ x: 0, y: 0, w: 1, h: 1 });
      stage.style.transform = `translate(${r.x}px, ${r.y}px) scale(${r.w})`;
      const active = hasWords && editor.tool === 'select' && editor.selectedId === null;
      if (root.dataset.active !== String(active)) root.dataset.active = String(active);
      const next = editor.doc.crop;
      setCrop((prev) => (sameCrop(prev, next) ? prev : next));
    };
    sync();
    const offs = [editor.on('change', sync), editor.on('select', sync), editor.on('tool', sync), editor.on('view', sync)];
    return () => offs.forEach((off) => off());
  }, [editor, hasWords]);

  // Stretch each word to the width OCR found for it, so the selection highlight sits exactly on the word.
  // All reads first, then all writes: one layout for the whole set, and only when the words change.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !hasWords) return;
    const measure = () => {
      const spans = [...stage.children] as HTMLSpanElement[];
      const natural = spans.map((el) => el.offsetWidth);
      spans.forEach((el, i) => {
        const w = visible[i]?.box.w ?? 0;
        const n = natural[i] ?? 0;
        el.style.transform = n > 0 && w > 0 ? `scaleX(${(w / n).toFixed(4)})` : '';
      });
    };
    measure();
    // A web font that arrives late changes the natural widths; measure once more when it has.
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) measure();
    });
    return () => {
      alive = false;
    };
  }, [visible, hasWords]);

  const onCopy = (e: ClipboardEvent) => {
    const sel = window.getSelection();
    const stage = stageRef.current;
    if (!sel || sel.isCollapsed || !stage) return;
    const picked: OcrWord[] = [];
    [...stage.children].forEach((el, i) => {
      const word = visible[i];
      if (word && sel.containsNode(el, true)) picked.push(word);
    });
    if (picked.length === 0) return;
    e.clipboardData.setData('text/plain', wordsToText(picked));
    e.preventDefault();
  };

  if (!words || words.length === 0) return null;
  return (
    <div ref={rootRef} className="pe-textlayer" role="group" aria-label="Recognised text" onCopy={onCopy}>
      <div ref={stageRef} className="pv-textstage">
        {visible.map((w, i) => (
          <span
            key={i}
            className="pe-word"
            style={{
              left: w.box.x,
              top: w.box.y,
              height: w.box.h,
              fontSize: Math.max(4, w.box.h * 0.8),
              lineHeight: `${w.box.h}px`,
            }}
          >
            {w.text}
          </span>
        ))}
      </div>
    </div>
  );
});
