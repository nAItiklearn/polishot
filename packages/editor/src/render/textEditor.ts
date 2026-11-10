import { FONT_STACK } from './scene';

export interface TextEditorOpen {
  /** Top-left of the text in CSS px, relative to the overlay element. */
  x: number;
  y: number;
  /** Font size in CSS px. */
  fontSize: number;
  color: string;
  text: string;
  /** Accessible name for the field. */
  label: string;
  onCommit(text: string): void;
  onCancel(): void;
}

const measureCtx = (() => {
  let ctx: CanvasRenderingContext2D | null = null;
  return () => (ctx ??= document.createElement('canvas').getContext('2d'));
})();

/**
 * Inline text editing: a plain `<textarea>` positioned over the canvas. The text is only ever read back as a
 * string via `.value` and drawn by Konva; it is never interpreted as HTML.
 */
export class TextEditor {
  private el: HTMLTextAreaElement | null = null;
  private done = false;

  constructor(private readonly overlay: HTMLElement) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(o: TextEditorOpen): void {
    this.close();
    this.done = false;
    const ta = document.createElement('textarea');
    ta.className = 'pe-text-input';
    ta.value = o.text;
    ta.rows = 1;
    ta.spellcheck = false;
    ta.wrap = 'off';
    ta.setAttribute('aria-label', o.label);
    ta.maxLength = 2000;
    Object.assign(ta.style, {
      position: 'absolute',
      left: `${o.x}px`,
      top: `${o.y}px`,
      margin: '0',
      padding: '0 2px',
      border: '0',
      outline: `1.5px dashed ${o.color}`,
      outlineOffset: '3px',
      background: 'transparent',
      color: o.color,
      font: `600 ${o.fontSize}px/1.25 ${FONT_STACK}`,
      resize: 'none',
      overflow: 'hidden',
      whiteSpace: 'pre',
      pointerEvents: 'auto',
      caretColor: o.color,
      minWidth: '2ch',
    } satisfies Partial<CSSStyleDeclaration>);
    const fit = () => {
      const ctx = measureCtx();
      const lines = ta.value.split('\n');
      let w = 0;
      if (ctx) {
        ctx.font = `600 ${o.fontSize}px ${FONT_STACK}`;
        for (const l of lines) w = Math.max(w, ctx.measureText(l || ' ').width);
      } else w = Math.max(...lines.map((l) => l.length)) * o.fontSize * 0.6;
      ta.style.width = `${Math.ceil(w) + 8}px`;
      ta.style.height = `${Math.ceil(lines.length * o.fontSize * 1.25) + 2}px`;
    };
    fit();
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.finish(false, o);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.finish(true, o);
      }
    });
    ta.addEventListener('blur', () => this.finish(true, o));
    // Do not let the canvas pointer handlers see clicks inside the field.
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.overlay.appendChild(ta);
    this.el = ta;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  /** Commits the current text (as if the field had lost focus). */
  commit(): void {
    this.el?.blur();
  }

  private finish(commit: boolean, o: TextEditorOpen): void {
    if (this.done || !this.el) return;
    this.done = true;
    const value = this.el.value;
    this.close();
    if (commit) o.onCommit(value);
    else o.onCancel();
  }

  /** Removes the field without committing or cancelling. */
  close(): void {
    if (!this.el) return;
    const el = this.el;
    this.el = null;
    this.done = true;
    el.remove();
  }

  destroy(): void {
    this.close();
  }
}
