import Link from 'next/link';
import { APP_NAME } from '@polishot/brand';
import { LogoMark } from '@/components/logo';
import { GitHubIcon } from '@/components/github-icon';
import { FOOTER_LINKS, PROJECT_STATUS, REPO_URL } from '@/lib/site';
import { latestRelease } from '@/lib/changelog';

const linkClass =
  'inline-flex h-9 items-center text-[15.5px] text-ink-2 transition-colors hover:text-ink';

const RESOURCES = new Set<string>(['/changelog', '/editor']);

const COLUMNS = [
  { title: 'Product', links: FOOTER_LINKS.product.filter((l) => !RESOURCES.has(l.href)) },
  { title: 'Resources', links: FOOTER_LINKS.product.filter((l) => RESOURCES.has(l.href)) },
  { title: 'Legal', links: FOOTER_LINKS.legal },
];

/** The page ends on one last line and the way to get it, with the mark watermarked behind. */
export function SiteFooter() {
  const release = latestRelease();
  const year = new Date().getFullYear();
  return (
    <footer className="offscreen-auto relative isolate overflow-hidden text-ink [contain-intrinsic-size:auto_720px]">
      <LogoMark mono className="footer-mark text-ink" />
      <div className="container-page pb-10 pt-24 md:pt-32">
        <div className="flex flex-col gap-10 md:flex-row md:items-end md:justify-between">
          <p className="display-1 text-[clamp(3rem,1.6rem+4.6vw,5.75rem)]">
            Screenshots,
            <em className="block text-accent-ink">made beautiful.</em>
          </p>
          <div className="flex flex-col items-start gap-3 md:items-end">
            <Link
              href="/download"
              className="btn-ember inline-flex h-14 items-center rounded-xl px-7 text-[17px] font-semibold transition-[background-color,box-shadow]"
            >
              Download {APP_NAME}, free
            </Link>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-[14px] text-ink-2 transition-colors hover:text-ink"
            >
              <GitHubIcon className="size-4" />
              Open source on GitHub
            </a>
          </div>
        </div>

        <div className="mt-20 grid gap-10 sm:grid-cols-3 md:mt-24 md:max-w-3xl">
          {COLUMNS.map((col) => (
            <nav key={col.title} aria-label={`Footer, ${col.title.toLowerCase()}`}>
              <h2 className="eyebrow mb-3">{col.title}</h2>
              <ul>
                {col.links.map((item) => (
                  <li key={item.href}>
                    {item.href === '/editor' ? (
                      // A full page load, so /editor gets its own security policy (OCR needs workers).
                      <a href={item.href} className={linkClass}>
                        {item.label}
                      </a>
                    ) : (
                      <Link href={item.href} prefetch={false} className={linkClass}>
                        {item.label}
                      </Link>
                    )}
                  </li>
                ))}
                {col.title === 'Resources' ? (
                  <li>
                    <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
                      Source code
                    </a>
                  </li>
                ) : null}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-40 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm text-ink-3 md:mt-56">
          <p>
            &copy; {year} {APP_NAME}. {PROJECT_STATUS.short}. {PROJECT_STATUS.license}.
          </p>
          {release ? (
            <p className="font-mono text-xs">
              <Link href="/changelog" className="hover:text-ink">
                v{release.version}
                {release.unreleased ? ' (unreleased)' : ''}
              </Link>
            </p>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
