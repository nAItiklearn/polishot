import { cx } from '../lib/format';
import { formatAccelerator } from '../lib/shortcuts';

/** One key cap. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  return <kbd className={cx('pv-kbd', className)}>{children}</kbd>;
}

/** A shortcut as key caps: `Ctrl+Shift+C` becomes three. Renders nothing for an empty accelerator. */
export function Keys({ accelerator, className }: { accelerator: string; className?: string }) {
  const parts = formatAccelerator(accelerator);
  if (parts.length === 0) return null;
  return (
    <span className={cx('pv-keys', className)}>
      {parts.map((p, i) => (
        <Kbd key={`${p}-${i}`}>{p}</Kbd>
      ))}
    </span>
  );
}

/** `aria-keyshortcuts` value for an accelerator (`Ctrl+C` becomes `Control+C`). */
export function ariaShortcut(accelerator: string): string | undefined {
  if (!accelerator) return undefined;
  return accelerator.replace(/\bCtrl\b/gi, 'Control').replace(/\bEsc\b/gi, 'Escape');
}
