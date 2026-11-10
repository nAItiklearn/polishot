import { cn } from '@/lib/utils';
import {
  LOCKUP_PATHS,
  LOCKUP_TRANSFORM,
  LOCKUP_VIEWBOX,
  MARK_PATHS,
  MARK_VIEWBOX,
  type BrandPath,
} from './brand/paths.generated';

/**
 * The Print P: a P whose bowl is a screenshot, tilted and pinned on the stem. Drawn from the masters in
 * packages/brand/assets (see scripts/sync-brand.mjs); never redraw, straighten, outline or recolour it.
 * "ink" and "accent" follow the design tokens, which equal the brand's light-theme and dark/ember colours.
 */
const FILL = { ink: 'var(--ps-text)', accent: 'var(--ps-accent)' } as const;

function Paths({ paths, mono }: { paths: BrandPath[]; mono?: boolean }) {
  return (
    <>
      {paths.map((p) => (
        <path
          key={p.d.slice(0, 24)}
          d={p.d}
          fill={mono ? 'currentColor' : FILL[p.role]}
          fillRule={p.evenodd ? 'evenodd' : undefined}
        />
      ))}
    </>
  );
}

/** The mark alone. Minimum size 16px (below 32px the app-icon-small master is better). */
export function LogoMark({ className, mono = false }: { className?: string; mono?: boolean }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
      style={{ aspectRatio: '1 / 1' }}
    >
      <Paths paths={MARK_PATHS} mono={mono} />
    </svg>
  );
}

const [, , LOCKUP_W, LOCKUP_H] = LOCKUP_VIEWBOX.split(' ').map(Number) as [number, number, number, number];

/**
 * The lockup: mark plus "Polishot" in outlined Instrument Serif, with the brand's clear space built in.
 * `height` is the size of the whole lockup in px (minimum 20).
 */
export function Wordmark({ className, height = 40 }: { className?: string; height?: number }) {
  return (
    <svg
      viewBox={LOCKUP_VIEWBOX}
      width={Math.round((height * LOCKUP_W) / LOCKUP_H)}
      height={height}
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
    >
      <g transform={LOCKUP_TRANSFORM}>
        <Paths paths={LOCKUP_PATHS} />
      </g>
    </svg>
  );
}
