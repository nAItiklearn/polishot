import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, Download, Smartphone } from 'lucide-react';
import { APP_NAME } from '@polishot/brand';
import { Button } from '@/components/ui/button';
import { ProductShot } from '@/components/product-shot';
import { ShaderBand } from '@/components/shaders/shader-band';
import type { ShotName } from '@/lib/shots';
import { LICENSE_PRICE } from '@/lib/site';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

interface ChapterProps {
  index: string;
  label: string;
  title: string;
  shot: ShotName;
  children: ReactNode;
}

/** One big idea: the heading on the left, two plain sentences on the right, then the product at full width. */
function Chapter({ index, label, title, shot, children }: ChapterProps) {
  const headingId = `chapter-${shot}`;
  return (
    <section aria-labelledby={headingId} className="container-page offscreen-auto">
      <div className="border-t border-line pb-24 pt-20 md:pb-36 md:pt-28">
        <div className="grid gap-8 md:grid-cols-12 md:gap-12">
          <div className="md:col-span-7">
            <p className="eyebrow">
              {index} <span className="mx-1.5 opacity-60">/</span> {label}
            </p>
            <h2 id={headingId} className="display-2 mt-6 max-w-[11em]">
              {title}
            </h2>
          </div>
          <div className="space-y-3 text-lg text-ink-2 md:col-span-4 md:col-start-9 md:pt-10">{children}</div>
        </div>
        <div className="mt-14 md:mt-24">
          <ProductShot
            name={shot}
            elevated
            className="rounded-lg"
            sizes="(min-width: 1280px) 1120px, 100vw"
          />
        </div>
      </div>
    </section>
  );
}

interface HalfProps {
  index: string;
  label: string;
  title: string;
  shot: ShotName;
  children: ReactNode;
}

/** Two smaller ideas side by side. */
function Half({ index, label, title, shot, children }: HalfProps) {
  const headingId = `half-${shot}`;
  return (
    <div>
      <p className="eyebrow">
        {index} <span className="mx-1.5 opacity-60">/</span> {label}
      </p>
      <h2 id={headingId} className="display-3 mt-5 max-w-[16em] text-[clamp(1.75rem,1.3rem+1.6vw,2.75rem)]">
        {title}
      </h2>
      <div className="mt-4 max-w-[40ch] space-y-3 text-lg text-ink-2">{children}</div>
      <div className="mt-10">
        <ProductShot
          name={shot}
          elevated
          className="rounded-lg"
          sizes="(min-width: 1280px) 540px, (min-width: 768px) 45vw, 100vw"
        />
      </div>
    </div>
  );
}

const PRIVACY_FACTS = [
  'Recognition runs on your device',
  'No account to create',
  'No telemetry by default',
  'No tracking cookies here',
];

export default function HomePage() {
  return (
    <>
      <ShaderBand variant="orbs" intensity={1} className="pb-52 pt-16 md:pb-80 md:pt-28">
        <div className="container-page">
          <p className="eyebrow">Windows and Android</p>
          <h1 className="display-1 mt-7 max-w-[10.5em]">
            Screenshots, <em className="text-accent-ink">finished</em> in about two seconds.
          </h1>

          <div className="mt-10 flex flex-col gap-8 md:mt-14 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="max-w-[34ch] text-lg text-ink-2 md:text-xl">
                Trim, frame, redact and copy the text, all on your own machine.
              </p>
              <p className="mt-4 font-mono text-xs text-ink-3">
                Free. Windows 10 and 11, Android 10 or later.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="w-full sm:w-auto">
                <Link href="/download#windows">
                  <Download aria-hidden="true" />
                  Download for Windows
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
                <Link href="/download#android">
                  <Smartphone aria-hidden="true" />
                  Get it on Android
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </ShaderBand>

      {/* The product floats over the edge of the dark hero. The wrapper re-scopes the tokens to dark so the
          placeholder and its shadow match the hero. */}
      <div data-theme="dark" className="relative z-10 -mt-44 mb-16 md:-mt-72 md:mb-28">
        <div className="container-page">
          <div className="relative mx-auto max-w-[1120px]">
            <div className="relative">
              <ProductShot
                name="hero-after"
                priority
                elevated
                className="rounded-lg"
                sizes="(min-width: 1280px) 1120px, 100vw"
              />
              <p className="absolute right-4 top-4 rounded-full border border-line bg-bg/70 px-3 py-1 font-mono text-xs text-ink-2 backdrop-blur">
                After, about two seconds later
              </p>
            </div>
            <figure className="relative mt-6 w-3/5 md:absolute md:-bottom-12 md:-left-10 md:mt-0 md:w-[30%]">
              <ProductShot
                name="hero-before"
                elevated
                className="rounded-md"
                sizes="(min-width: 1280px) 340px, (min-width: 768px) 30vw, 60vw"
              />
              <p className="absolute left-3 top-3 rounded-full border border-line bg-bg/70 px-3 py-1 font-mono text-xs text-ink-2 backdrop-blur">
                Before
              </p>
            </figure>
          </div>
        </div>
      </div>

      <Chapter index="01" label="Balance" title="Framed evenly, without a crop tool." shot="balance">
        <p>{APP_NAME} trims the dead borders and sets padding in proportion to what is left.</p>
        <p>
          The background is sampled from the edges of your screenshot, so it never clashes with the window it
          frames.
        </p>
      </Chapter>

      <Chapter index="02" label="Redact" title="Sensitive details, covered before you share." shot="redact">
        <p>
          Email addresses, card numbers, IP addresses and API keys are found and listed. You review each one,
          then cover them with blur or a solid bar in a click.
        </p>
        <p>Redaction runs on your machine. Nothing is uploaded.</p>
      </Chapter>

      <ShaderBand
        variant="silk"
        offset={[0, 0.2]}
        labelledBy="privacy-title"
      >
        <div
          className="container-page flex min-h-[560px] flex-col justify-end pb-16 pt-40 md:min-h-[680px] md:pb-24"
        >
          <p className="eyebrow">Privacy</p>
          <h2 id="privacy-title" className="display-page mt-6 max-w-[11em]">
            Nothing leaves your <em className="text-accent-ink">machine.</em>
          </h2>
          <p className="mt-6 max-w-[46ch] text-lg text-ink-2 md:text-xl">
            Capture, redaction and text recognition all run on your device. There is no account, and the apps
            send no telemetry by default.
          </p>
          <ul className="mt-10 flex flex-wrap gap-x-8 gap-y-3 font-mono text-xs text-ink-3">
            {PRIVACY_FACTS.map((fact) => (
              <li key={fact} className="flex items-center gap-2">
                <span aria-hidden="true" className="size-1 rounded-full bg-accent" />
                {fact}
              </li>
            ))}
          </ul>
          <p className="mt-10">
            <Link href="/privacy" className="link-quiet inline-flex items-center gap-1.5 text-ink">
              Read the privacy policy
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </p>
        </div>
      </ShaderBand>

      <section aria-label="Text and export" className="container-page offscreen-auto">
        <div className="grid gap-20 pb-24 pt-24 md:grid-cols-2 md:gap-16 md:pb-36 md:pt-36">
          <Half index="03" label="Text" title="The words in your screenshot, ready to paste." shot="ocr">
            <p>
              On-device text recognition makes the writing in a capture selectable. Drag across it and press
              Ctrl+C.
            </p>
          </Half>
          <Half index="04" label="Export" title="Sized for where it is going." shot="export">
            <p>
              X, LinkedIn, Instagram, YouTube or your own size. PNG, JPEG or WebP at 1x, 2x or 3x, or copy it
              straight to the clipboard.
            </p>
          </Half>
        </div>
      </section>

      <Chapter
        index="05"
        label="Quick send"
        title="Between your phone and PC, over your own Wi-Fi."
        shot="quick-send"
      >
        <p>
          Pair your devices once by matching a six-digit code. After that, images travel directly between
          them, encrypted.
        </p>
        <p>There is no account and no cloud in the middle.</p>
      </Chapter>

      <ShaderBand
        variant="gold"
        intensity={0.9}
        labelledBy="price-title"
      >
        <div
          className="container-page flex min-h-[520px] flex-col items-start justify-end pb-16 pt-40 md:min-h-[600px] md:pb-24"
        >
          <h2 id="price-title" className="display-2 max-w-[12em]">
            Free, with every feature. Pro is <em className="text-accent-ink">{LICENSE_PRICE}</em>, once.
          </h2>
          <p className="mt-6 max-w-[52ch] text-lg text-ink-2">
            Pro removes the watermark, adds your own brand mark, lifts the limits on presets and batch, and
            includes a year of updates.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/download">
                <Download aria-hidden="true" />
                Download free
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
        </div>
      </ShaderBand>
    </>
  );
}
