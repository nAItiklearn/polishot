import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { APP_NAME } from '@polishot/brand';
import { Wordmark } from '@/components/logo';
import { FOOTER_LINKS, GITHUB_URL } from '@/lib/site';
import { latestRelease } from '@/lib/changelog';

const linkClass = 'inline-flex h-9 items-center text-[15px] text-ink-2 transition-colors hover:text-ink';

/** The page ends the way it begins: dark, with the brand lockup. */
export function SiteFooter() {
  const release = latestRelease();
  const year = new Date().getFullYear();
  return (
    <footer
      data-theme="dark"
      className="offscreen-auto border-t border-line bg-bg text-ink [contain-intrinsic-size:auto_480px]"
    >
      <div className="container-page grid gap-12 py-16 md:grid-cols-12">
        <div className="md:col-span-5">
          <Wordmark height={48} className="-ml-3" />
          <p className="mt-5 max-w-[34ch] text-ink-2">
            Screenshots, finished in about two seconds. Free on Windows and Android.
          </p>
        </div>

        <nav aria-label="Footer, product" className="md:col-span-2 md:col-start-7">
          <h2 className="eyebrow mb-3">Product</h2>
          <ul>
            {FOOTER_LINKS.product.map((item) => (
              <li key={item.href}>
                <Link href={item.href} prefetch={false} className={linkClass}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="Footer, legal" className="md:col-span-2">
          <h2 className="eyebrow mb-3">Legal</h2>
          <ul>
            {FOOTER_LINKS.legal.map((item) => (
              <li key={item.href}>
                <Link href={item.href} prefetch={false} className={linkClass}>
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <a href={GITHUB_URL} className={linkClass} rel="noopener noreferrer" target="_blank">
                GitHub
                <ArrowUpRight className="ml-1 size-4" aria-hidden="true" />
              </a>
            </li>
          </ul>
        </nav>

      </div>

      <div className="border-t border-line">
        <div className="container-page flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-6 text-sm text-ink-3">
          <p>
            &copy; {year} {APP_NAME}
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
