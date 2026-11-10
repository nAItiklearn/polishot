import { useCallback, useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { Editor } from '../editor';

/** Section with a title; the unit the inspector is built from. */
export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  const id = useId();
  return (
    <section className="pe-section" aria-labelledby={id}>
      <div className="pe-section-head">
        <h3 className="pe-section-title" id={id}>
          {title}
        </h3>
        {aside}
      </div>
      <div className="pe-section-body">{children}</div>
    </section>
  );
}

export function Field({ label, htmlFor, value, children }: { label: string; htmlFor?: string; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="pe-field">
      <div className="pe-field-head">
        <label className="pe-label" htmlFor={htmlFor}>
          {label}
        </label>
        {value !== undefined && <output className="pe-value">{value}</output>}
      </div>
      {children}
    </div>
  );
}

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Accessible name when the visible label is not enough (icons, "2x"). */
  name?: string;
}

/** A row of mutually exclusive buttons (aria-pressed), arrow-key friendly through normal tab order. */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`pe-segmented ${className ?? ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className="pe-seg"
          aria-pressed={o.value === value}
          aria-label={o.name}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Range input that feels physical. Dragging updates the canvas every frame and the whole drag is one undo step
 * (the editor transaction opens on pointer/keyboard down and closes on release). The arrow keys nudge by one
 * `nudge` unit (Shift: ten), holding a key is still one undo step, and double-clicking resets to `reset`.
 */
export function Slider({
  editor,
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
  nudge,
  reset,
}: {
  editor: Editor;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  /** What one arrow-key press changes, in the slider's own units (default: `step`); Shift multiplies by 10. */
  nudge?: number;
  /** Value a double-click resets to. Omit to disable the gesture. */
  reset?: number;
}) {
  const id = useId();
  const open = useRef(false);
  const begin = useCallback(() => {
    if (!open.current) {
      open.current = true;
      editor.beginBatch();
    }
  }, [editor]);
  const end = useCallback(() => {
    if (open.current) {
      open.current = false;
      editor.endBatch();
    }
  }, [editor]);
  const pct = ((value - min) / (max - min)) * 100;
  const unit = nudge ?? step;
  const settle = (v: number) => Math.min(max, Math.max(min, Math.round(v * 1e6) / 1e6));
  return (
    <Field label={label} htmlFor={id} value={format(value)}>
      <input
        id={id}
        className="pe-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--pe-fill': `${Math.min(100, Math.max(0, pct))}%` } as CSSProperties}
        onPointerDown={begin}
        onPointerUp={end}
        onPointerCancel={end}
        title={reset !== undefined ? 'Double-click to reset' : undefined}
        onDoubleClick={
          reset === undefined
            ? undefined
            : () => {
                begin();
                onChange(settle(reset));
                end();
              }
        }
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          const dir =
            e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
          if (dir !== 0 && !e.altKey && !e.ctrlKey && !e.metaKey) {
            // 1 unit per press, 10 with Shift, whatever the slider's native step is.
            e.preventDefault();
            begin();
            onChange(settle(value + dir * unit * (e.shiftKey ? 10 : 1)));
            return;
          }
          if (e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) begin();
        }}
        onKeyUp={end}
        onBlur={end}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-valuetext={format(value)}
      />
    </Field>
  );
}

/** Keyboard shortcut in Geist Mono style. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="pe-kbd">{children}</kbd>;
}

/** Icon button with an accessible name and a hover/focus tooltip that shows the shortcut. */
export function IconButton({
  label,
  shortcut,
  pressed,
  disabled,
  onClick,
  children,
  tipSide = 'top',
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  tipSide?: 'top' | 'bottom';
}) {
  return (
    <button
      type="button"
      className="pe-iconbtn"
      aria-label={label}
      aria-keyshortcuts={shortcut}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      data-tip-side={tipSide}
    >
      {children}
      <span className="pe-tip" aria-hidden="true">
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </span>
    </button>
  );
}
