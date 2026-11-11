import { cn } from '@/lib/utils';

/** A dark, slightly raised key. */
export function Keycap({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn('keycap', className)}>{children}</kbd>;
}

/** A joined shortcut such as Ctrl + Shift + 2. Read out as one label. */
export function Keys({
  keys,
  className,
  size,
}: {
  keys: string[];
  className?: string;
  size?: 'sm';
}) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 align-middle', className)}
      aria-label={keys.join(' + ')}
      role="img"
    >
      {keys.map((k, i) => (
        <span key={k} className="inline-flex items-center gap-1" aria-hidden="true">
          {i > 0 ? <span className="text-[0.8em] text-ink-3">+</span> : null}
          <Keycap className={size === 'sm' ? 'keycap-sm' : undefined}>{k}</Keycap>
        </span>
      ))}
    </span>
  );
}
