import Link from 'next/link';
import { APP_NAME } from '@polishot/brand';
import { Button } from '@/components/ui/button';
import { Wordmark } from '@/components/logo';
import { NavLinks } from '@/components/nav-links';
import { ThemeToggle } from '@/components/theme-toggle';
import { MobileNav } from '@/components/mobile-nav';
import { VisitorCounter } from '@/components/visitor-counter';
import { visitorCounterEnabled } from '@/lib/visits';

/**
 * Always dark (data-theme="dark"), in both themes: translucent glass over whatever scrolls beneath, so it
 * sits seamlessly on the shader heroes and still reads as one bar over light pages.
 */
export function SiteHeader() {
  const showVisitors = visitorCounterEnabled();
  return (
    <header
      data-theme="dark"
      className="sticky top-0 z-40 border-b border-line bg-bg/90 text-ink backdrop-blur-xl"
    >
      <div className="container-page flex h-16 items-center justify-between gap-6">
        <Link href="/" aria-label={`${APP_NAME}, home`} className="-ml-1 rounded-md p-1">
          <Wordmark />
        </Link>
        <nav aria-label="Primary" className="hidden md:block">
          <NavLinks />
        </nav>
        <div className="flex items-center gap-1">
          {showVisitors ? <VisitorCounter /> : null}
          <ThemeToggle />
          <div className="ml-2 hidden md:block">
            <Button asChild size="sm">
              <Link href="/download">Download</Link>
            </Button>
          </div>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
