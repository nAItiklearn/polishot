import { APP_NAME } from '@polishot/brand';
import { cn } from '@/lib/utils';

/**
 * The mark: a rounded square with a second frame sitting off-centre inside it.
 * The inner frame is cut out in the page colour, so the mark follows the theme.
 * (app/icon.svg is the same drawing on a near-black tile.)
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="4 4 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
    >
      <rect x="5" y="5" width="22" height="22" rx="6.5" fill="var(--ps-accent)" />
      <rect
        x="11"
        y="11"
        width="12"
        height="12"
        rx="3"
        fill="none"
        stroke="var(--ps-bg)"
        strokeWidth="2.25"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="font-display text-[26px] leading-none tracking-[-0.02em] text-ink">
        {APP_NAME}
      </span>
    </span>
  );
}
