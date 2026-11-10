import type { Metadata } from 'next';
import { APP_NAME } from '@polishot/brand';
import { PageHeader } from '@/components/page-header';
import { FEATURE_GROUPS } from '@/lib/features';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Features',
  description: `Everything ${APP_NAME} does, listed plainly: capture, auto-balance, auto-redact, text copy, annotation, presets, export and quick send. All of it is in the free version.`,
  path: '/features',
});

export default function FeaturesPage() {
  return (
    <>
      <PageHeader eyebrow="Features" title="Every feature, plainly listed." variant="silk" intensity={0.75} offset={[0, 0.2]}>
        All of it is in the free version. Pro removes the watermark and lifts the limits on presets and batch.
        Where a feature is on one platform only, it says so.
      </PageHeader>

      <nav aria-label="Feature groups" className="container-page pb-8">
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-[15px]">
          {FEATURE_GROUPS.map((group) => (
            <li key={group.id}>
              <a href={`#${group.id}`} className="link-quiet inline-flex h-10 items-center text-ink-2 hover:text-ink">
                {group.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {FEATURE_GROUPS.map((group) => (
        <section key={group.id} id={group.id} aria-labelledby={`${group.id}-title`} className="container-page">
          <div className="grid gap-8 border-t border-line py-14 md:grid-cols-12 md:gap-16 md:py-20">
            <div className="md:col-span-3">
              <div className="md:sticky md:top-28">
                <h2 id={`${group.id}-title`} className="display-3">
                  {group.title}
                </h2>
                <p className="mt-3 max-w-[28ch] text-[15px] text-ink-3">{group.intro}</p>
              </div>
            </div>

            <dl className="md:col-span-9">
              {group.items.map((item, i) => (
                <div
                  key={item.id}
                  id={item.id}
                  className={`grid gap-3 py-7 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-10 ${
                    i === 0 ? 'pt-0 md:pt-0' : 'border-t border-line'
                  }`}
                >
                  <dt>
                    <span className="block text-[17px] font-medium text-ink">{item.name}</span>
                    <span className="mt-1 block font-mono text-xs text-ink-3">{item.platform}</span>
                    {item.keys ? (
                      <span className="mt-3 flex flex-wrap gap-1.5">
                        <span className="sr-only">Keys:</span>
                        {item.keys.map((key) => (
                          <kbd
                            key={key}
                            className="inline-flex h-6 min-w-6 items-center justify-center rounded-sm border border-line bg-surface px-1.5 text-ink-2 shadow-low"
                          >
                            {key}
                          </kbd>
                        ))}
                      </span>
                    ) : null}
                  </dt>
                  <dd className="space-y-3 text-ink-2">
                    {item.body.map((paragraph) => (
                      <p key={paragraph}>{paragraph}</p>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      ))}
    </>
  );
}
