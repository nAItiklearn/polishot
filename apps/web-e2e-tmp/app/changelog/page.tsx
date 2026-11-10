import type { Metadata } from 'next';
import { APP_NAME } from '@polishot/brand';
import { Markdown } from '@/components/markdown';
import { PageHeader } from '@/components/page-header';
import { loadChangelog } from '@/lib/changelog';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Changelog',
  description: `What changed in each release of ${APP_NAME}.`,
  path: '/changelog',
});

export default function ChangelogPage() {
  // Read from the repository's CHANGELOG.md when the site is built.
  const releases = loadChangelog();

  return (
    <>
      <PageHeader eyebrow="Changelog" title="What changed, release by release.">
        Newest first. This page is built from the changelog in the repository.
      </PageHeader>

      <div className="container-page">
        {releases.length === 0 ? (
          <p className="border-t border-line py-14 text-ink-2">No releases have been written up yet.</p>
        ) : (
          releases.map((release) => (
            <section
              key={release.version}
              aria-labelledby={`v${release.version}`}
              className="grid gap-6 border-t border-line py-12 md:grid-cols-12 md:gap-16 md:py-16"
            >
              <header className="md:col-span-3">
                <h2 id={`v${release.version}`} className="display-3">
                  {release.version}
                </h2>
                {release.label ? (
                  <p
                    className={`mt-3 inline-flex h-7 items-center rounded-full border px-3 font-mono text-xs ${
                      release.unreleased ? 'border-accent-ink/40 text-accent-ink' : 'border-line text-ink-3'
                    }`}
                  >
                    {release.label}
                  </p>
                ) : null}
              </header>
              <div className="prose-ps md:col-span-9">
                <Markdown blocks={release.blocks} />
              </div>
            </section>
          ))
        )}
      </div>
    </>
  );
}
