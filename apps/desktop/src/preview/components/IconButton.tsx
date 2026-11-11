import type { ReactNode, Ref } from 'react';
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
  /** The button element, for anchoring a menu to it. */
  ref?: Ref<HTMLButtonElement>;
  /** The button opens a menu (for assistive technology). */
  menu?: boolean;
  expanded?: boolean;
  /** -1 takes the button out of the tab order (it stays clickable and has another keyboard route). */
  tabIndex?: number;
}

/** Icon-only button: always has an aria-label, and a tooltip on hover and keyboard focus. */
export function IconButton({ label, onClick, children, shortcut, pressed, disabled, tipAlign = 'center', className, ref, menu, expanded, tabIndex }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx('pv-iconbtn', className)}
      aria-label={label}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      aria-pressed={pressed}
      aria-haspopup={menu ? 'menu' : undefined}
      aria-expanded={menu ? (expanded ?? false) : undefined}
      disabled={disabled}
      tabIndex={tabIndex}
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
