import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ShaderCanvas } from './shader-canvas';
import type { ShaderVariant } from './shaders';

interface ShaderBandProps {
  /** Which live background to run. Omit for a still dark band (no WebGL at all). */
  variant?: ShaderVariant;
  intensity?: number;
  offset?: [number, number];
  /** Darkens the top and bottom edges so text and the next section stay legible. */
  scrim?: 'edges' | 'bottom' | 'none';
  as?: ElementType;
  /** id of the heading that names this band (turns a section into a labelled landmark). */
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A full-bleed band that is always dark, in both themes: it re-scopes the design tokens with
 * data-theme="dark", then layers (back to front) a live shader, a fine film-grain overlay and a scrim.
 * Without a variant it is just the dark surface with a faint ember wash, so quiet pages stay light.
 */
export function ShaderBand({
  variant,
  intensity = 1,
  offset,
  scrim = 'edges',
  as: Tag = 'section',
  labelledBy,
  className,
  children,
}: ShaderBandProps) {
  return (
    <Tag data-theme="dark" aria-labelledby={labelledBy} className={cn('relative isolate overflow-hidden bg-bg text-ink', className)}>
      {variant ? (
        <ShaderCanvas variant={variant} intensity={intensity} offset={offset} />
      ) : (
        <div aria-hidden="true" className="shader-surface" data-variant="still" />
      )}
      <div aria-hidden="true" className="shader-grain" />
      {scrim !== 'none' ? <div aria-hidden="true" className="shader-scrim" data-scrim={scrim} /> : null}
      {children}
    </Tag>
  );
}
