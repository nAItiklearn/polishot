import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ShaderBand } from '@/components/shaders/shader-band';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false },
};

export default function NotFound() {
  return (
    <ShaderBand className="flex min-h-[calc(100dvh-4rem)] flex-col justify-center">
      <div className="container-page py-24">
        <p className="eyebrow mb-6">404</p>
        <h1 className="display-page max-w-[10em]">
          This page is <em className="text-accent-ink">not here.</em>
        </h1>
        <p className="mt-8 max-w-[44ch] text-lg text-ink-2 md:text-xl">
          The link may be old, or the address mistyped. The pages that do exist are one click away.
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link href="/">Go to the home page</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/features">See the features</Link>
          </Button>
        </div>
      </div>
    </ShaderBand>
  );
}
