/** Small form controls shared by Settings and License. Buttons, inputs and ranges reuse the editor's `pe-*` classes. */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../lib/format';

/** On/off switch. A button with role="switch", so Space and Enter toggle it. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Accessible name; the visible label sits next to it in a SettingRow. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="pv-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="pv-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
}

/** Mutually exclusive choices as a radio group with arrow-key movement. */
export function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = options[next];
    if (!target) return;
    onChange(target.value);
    refs.current[next]?.focus();
  };
  return (
    <div className="pe-segmented pv-choices" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o, idx) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: only the selected option is a tab stop; arrows move within the group.
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className="pe-seg"
            aria-pressed={undefined}
            data-selected={selected}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled row: name and optional description on the left, the control on the right. */
export function SettingRow({
  title,
  description,
  children,
  htmlFor,
  stacked,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  /** Put the control under the text instead of beside it. */
  stacked?: boolean;
}) {
  const descId = useId();
  return (
    <div className={cx('pv-row', stacked && 'pv-row-stacked')}>
      <div className="pv-row-text">
        {htmlFor ? (
          <label className="pv-row-title" htmlFor={htmlFor}>
            {title}
          </label>
        ) : (
          <div className="pv-row-title">{title}</div>
        )}
        {description ? (
          <div className="pv-row-desc" id={descId}>
            {description}
          </div>
        ) : null}
      </div>
      <div className="pv-row-control">{children}</div>
    </div>
  );
}

/** A titled group of rows. */
export function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="pv-group" aria-labelledby={id}>
      <h2 className="pv-group-title" id={id}>
        {title}
      </h2>
      <div className="pv-group-body">{children}</div>
    </section>
  );
}
