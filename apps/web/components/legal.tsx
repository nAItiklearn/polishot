import type { ReactNode } from 'react';
import { PageHeader } from '@/components/page-header';
import { LEGAL_REVIEWED, LEGAL_UPDATED } from '@/lib/site';

interface LegalPageProps {
  eyebrow: string;
  title: string;
  lead: string;
  children: ReactNode;
}

/** Shared frame for /privacy and /terms: title, a review notice while the text is a template, then prose. */
export function LegalPage({ eyebrow, title, lead, children }: LegalPageProps) {
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title}>
        {lead}
      </PageHeader>
      <div className="container-page pb-24 md:pb-32">
        {LEGAL_REVIEWED ? null : (
          <p
            role="note"
            className="mb-10 max-w-[68ch] rounded-md border border-line bg-surface-2 px-5 py-4 text-[15px] text-ink-2"
          >
            <strong className="font-medium text-ink">Template.</strong> This text has not been reviewed by a
            lawyer. Review and adjust it before you publish it.
          </p>
        )}
        <div className="prose-ps border-t border-line pt-2">{children}</div>
        <p className="mt-16 text-sm text-ink-3">Last updated {LEGAL_UPDATED}.</p>
      </div>
    </>
  );
}
