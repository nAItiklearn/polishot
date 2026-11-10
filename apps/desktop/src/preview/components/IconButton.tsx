import type { ReactNode } from 'react';
import { cx } from '../lib/format';
import { Keys, ariaShortcut } from './Keys';

export interface IconButtonProps {
  /** Accessible name and tooltip text. */
  label: string;
  onClick: () => void;
  children: ReactNode;
  /** Shown in the tooltip next to the label. */
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  /** Where the tooltip hangs relative to the button. Use "end" for buttons on the right edge. */
  tipAlign?: 'center' | 'start' | 'end';
  className?: string;
}

/** Icon-only button: always has an aria-label, and a tooltip on hover and keyboard focus. */
export function IconButton({ label, onClick, children, shortcut, pressed, disabled, tipAlign = 'center', className }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx('pv-iconbtn', className)}
      aria-label={label}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      data-tip-align={tipAlign}
    >
      {children}
      <span className="pv-tip" aria-hidden="true">
        {label}
        {shortcut ? <Keys accelerator={shortcut} /> : null}
      </span>
    </button>
  );
}
