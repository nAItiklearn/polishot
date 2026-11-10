import type { ReactNode } from 'react';
import { ShaderBand } from '@/components/shaders/shader-band';
import type { ShaderVariant } from '@/components/shaders/shaders';

interface PageHeaderProps {
  eyebrow?: string;
  title: ReactNode;
  children?: ReactNode;
  /** Live background behind the title. Omit for the still dark band (no WebGL). */
  variant?: ShaderVariant;
  intensity?: number;
  offset?: [number, number];
}

/**
 * Title block shared by the inner pages: a dark band with a mono label, one large serif h1 and a lead
 * paragraph. The band stays dark in both themes; the page below follows the theme.
 */
export function PageHeader({ eyebrow, title, children, variant, intensity = 0.85, offset }: PageHeaderProps) {
  return (
    <ShaderBand
      as="header"
      variant={variant}
      intensity={intensity}
      offset={offset}
      className="border-b border-line"
    >
      <div className="container-page pb-16 pt-20 md:pb-24 md:pt-32">
        {eyebrow ? <p className="eyebrow mb-6">{eyebrow}</p> : null}
        <h1 className="display-page max-w-[13em]">{title}</h1>
        {children ? <p className="mt-8 max-w-[48ch] text-lg text-ink-2 md:text-xl">{children}</p> : null}
      </div>
    </ShaderBand>
  );
}
