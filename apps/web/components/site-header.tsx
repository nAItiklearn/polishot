import Link from 'next/link';
import { APP_NAME } from '@polishot/brand';
import { Wordmark } from '@/components/logo';
import { NavLinks } from '@/components/nav-links';
import { MobileNav } from '@/components/mobile-nav';
import { VisitorCounter } from '@/components/visitor-counter';
import { visitorCounterEnabled } from '@/lib/visits';

/** A floating pill of frosted paper, centred over the page. */
export function SiteHeader() {
  const showVisitors = visitorCounterEnabled();
  return (
    <header className="sticky top-0 z-40 px-3 pt-3 md:px-6 md:pt-4">
      <div className="nav-pill mx-auto flex h-16 max-w-[1080px] items-center justify-between gap-6 rounded-2xl pl-4 pr-2.5 text-ink md:h-[68px] md:pl-5">
        <Link href="/" aria-label={`${APP_NAME}, home`} className="rounded-md p-1">
          <Wordmark />
        </Link>
        <nav aria-label="Primary" className="hidden md:block">
          <NavLinks />
        </nav>
        <div className="flex items-center gap-2">
          {showVisitors ? <VisitorCounter /> : null}
          <Link
            href="/download"
            className="btn-ember hidden h-11 items-center gap-2 rounded-xl px-5 text-[15px] font-semibold transition-[background-color,box-shadow] md:inline-flex"
          >
            Download
          </Link>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
