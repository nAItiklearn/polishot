import fs from 'node:fs';
import path from 'node:path';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { getShot, type ShotName } from '@/lib/shots';

interface ProductShotProps {
  name: ShotName;
  /** Set on the first image of a page (LCP). */
  priority?: boolean;
  /** Same meaning as next/image `sizes`. */
  sizes?: string;
  /** Larger shadow, for the hero image. */
  elevated?: boolean;
  className?: string;
}

/**
 * Pages are statically rendered, so this check runs at build time: once tools/shots has written
 * public/shots/<name>.webp and the site is rebuilt, the real capture replaces the placeholder.
 */
function shotFileExists(name: ShotName): boolean {
  const { src } = getShot(name);
  return fs.existsSync(path.join(process.cwd(), 'public', src));
}

const MARK = 'absolute size-4 border-ink-3/60';

export function ProductShot({ name, priority = false, sizes = '100vw', elevated = false, className }: ProductShotProps) {
  const shot = getShot(name);

  if (shotFileExists(name)) {
    return (
      <Image
        src={shot.src}
        width={shot.width}
        height={shot.height}
        alt={shot.alt}
        sizes={sizes}
        priority={priority}
        className={cn('h-auto w-full rounded-md border border-line', elevated ? 'shadow-high' : 'shadow-low', className)}
      />
    );
  }

  // Neutral placeholder: a quiet surface with capture marks in the corners and the file it waits for.
  return (
    <div
      aria-hidden="true"
      data-shot-placeholder={name}
      style={{ aspectRatio: `${shot.width} / ${shot.height}` }}
      className={cn(
        'relative w-full overflow-hidden rounded-md border border-line bg-surface-2',
        elevated && 'shadow-high',
        className,
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(var(--ps-border)_1px,transparent_1px)] [background-size:16px_16px] opacity-70" />
      <span className={cn(MARK, 'left-4 top-4 border-l border-t')} />
      <span className={cn(MARK, 'right-4 top-4 border-r border-t')} />
      <span className={cn(MARK, 'bottom-4 left-4 border-b border-l')} />
      <span className={cn(MARK, 'bottom-4 right-4 border-b border-r')} />
      <p className="absolute inset-x-0 bottom-7 px-8 text-center font-mono text-xs text-ink-3">
        {name}.webp
        <span className="mx-2 opacity-60">/</span>
        {shot.width} &times; {shot.height}
      </p>
    </div>
  );
}
