import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, Download, Smartphone } from 'lucide-react';
import { APP_NAME } from '@polishot/brand';
import { HeroDemo } from '@/components/home/hero-demo';
import { Toolkit } from '@/components/home/toolkit';
import { RedactDemo } from '@/components/home/redact-demo';
import { QuickSendDemo } from '@/components/home/quick-send-demo';
import { TextDemo } from '@/components/home/text-demo';
import { Keys } from '@/components/home/keycap';
import { LICENSE_PRICE, SHARE_SAFE_SOON } from '@/lib/site';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M0 2.2 6.5 1.3v6.2H0zM7.3 1.2 16 0v7.5H7.3zM0 8.3h6.5v6.3L0 13.7zM7.3 8.3H16V16l-8.7-1.2z" />
    </svg>
  );
}

interface SplitProps {
  id: string;
  numeral: string;
  label: string;
  title: ReactNode;
  demo: ReactNode;
  flip?: boolean;
  children: ReactNode;
}

/** One idea: a live demo on one side, a numbered headline and two plain sentences on the other. */
function Split({ id, numeral, label, title, demo, flip, children }: SplitProps) {
  return (
    <section aria-labelledby={id} className="container-page py-20 md:py-32">
      <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-16">
        <div className={cn('lg:col-span-7', flip && 'lg:order-2')}>{demo}</div>
        <div className={cn('lg:col-span-5', flip && 'lg:order-1')}>
          <p className="section-mark">
            <b>{numeral}</b>
            {label}
          </p>
          <h2 id={id} className="display-2 mt-5 text-[clamp(2.25rem,1.4rem+2.1vw,3.5rem)]">
            {title}
          </h2>
          <div className="mt-6 space-y-4 text-lg leading-relaxed text-ink-2">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** A feature on the roadmap. Always labelled; never worded as if it ships today. */
function SoonNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div data-testid="soon-note" className="mt-8 border-l-2 border-accent/40 pl-5">
      <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-accent-ink">
        {SHARE_SAFE_SOON}
      </p>
      <p className="mt-2 font-semibold text-ink">{title}</p>
      <p className="mt-1 text-[15px] text-ink-3">{children}</p>
    </div>
  );
}

const PRIVACY_FACTS = [
  'Recognition runs on your device',
  'No account to create',
  'No analytics of our own',
  'No tracking cookies here',
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section
        aria-labelledby="hero-title"
        className="container-page pb-16 pt-14 text-center md:pb-24 md:pt-24"
      >
        <h1 id="hero-title" className="hero-title">
          {APP_NAME} <em className="block text-accent-ink">private by default.</em>
        </h1>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/download#windows"
            className="btn-ember inline-flex h-14 items-center gap-3 rounded-xl px-7 text-[17px] font-semibold transition-[background-color,box-shadow] active:translate-y-px"
          >
            <WindowsIcon className="size-[18px]" />
            Download for Windows
          </Link>
          <Link
            href="/download#android"
            className="inline-flex h-14 items-center gap-2.5 rounded-xl border border-line bg-surface/70 px-6 text-[16px] font-semibold text-ink transition-colors hover:border-ink-3"
          >
            <Smartphone className="size-[18px]" aria-hidden="true" />
            Get it on Android
          </Link>
        </div>
        <div className="mt-16 md:mt-20">
          <HeroDemo />
        </div>
      </section>

      {/* Toolkit */}
      <section
        aria-labelledby="toolkit-title"
        className="offscreen-auto mx-auto w-full max-w-[1480px] px-6 py-20 md:px-10 md:py-28 [contain-intrinsic-size:auto_1200px]"
      >
        <Toolkit>
          <p className="section-mark justify-center">
            <b>—</b>
            The toolkit
          </p>
          <h2 id="toolkit-title" className="display-1 mt-5 text-[clamp(2.75rem,1.5rem+2.6vw,4rem)]">
            Everything a screenshot <em className="text-accent-ink">should do.</em>
          </h2>
          <p className="mx-auto mt-6 max-w-[40ch] text-lg leading-relaxed text-ink-2">
            One shortcut to capture, then everything else is a click away. Hover a card to see it
            work.
          </p>
        </Toolkit>
      </section>

      <Split
        id="redact-title"
        numeral="01"
        label="Redact"
        title={
          <>
            Sensitive details, <em className="text-accent-ink">covered</em> before you share.
          </>
        }
        demo={<RedactDemo />}
      >
        <p>
          Email addresses, card numbers, IP addresses and API keys are found and listed. Review each
          one, then cover it with blur or a solid bar. Try it on the left.
        </p>
        <p>Redaction runs on your machine. Nothing is uploaded.</p>
        <SoonNote title="Share-safe check">
          One more look just before you copy or export. {APP_NAME} rescans the finished image for
          emails, keys, cards, faces and QR codes, and offers one-click blur.
        </SoonNote>
      </Split>

      {/* Privacy statement */}
      <section
        aria-labelledby="privacy-title"
        className="container-page py-20 text-center md:py-32"
      >
        <p className="section-mark justify-center">
          <b>—</b>
          Privacy
        </p>
        <h2
          id="privacy-title"
          className="display-1 mx-auto mt-5 max-w-[12em] text-[clamp(3rem,1.6rem+4.6vw,5.75rem)]"
        >
          Your screenshots stay <em className="text-accent-ink">yours.</em>
        </h2>
        <p className="mx-auto mt-6 max-w-[46ch] text-lg leading-relaxed text-ink-2 md:text-xl">
          Capture, redaction and text recognition all run on your device. Your images and the text in
          them are never uploaded, and there is no account.
        </p>
        <ul className="mx-auto mt-10 flex max-w-3xl flex-wrap justify-center gap-3">
          {PRIVACY_FACTS.map((fact) => (
            <li
              key={fact}
              className="rounded-full border border-line bg-surface/70 px-4 py-2 text-[14px] font-medium text-ink-2"
            >
              {fact}
            </li>
          ))}
        </ul>
        <p className="mt-10">
          <Link
            href="/privacy"
            className="link-quiet inline-flex items-center gap-1.5 font-medium text-ink"
          >
            Read the privacy policy
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </p>
      </section>

      <Split
        id="send-title"
        numeral="02"
        label="Quick send"
        title={
          <>
            From your phone to your PC, <em className="text-accent-ink">over your own Wi-Fi.</em>
          </>
        }
        demo={<QuickSendDemo />}
        flip
      >
        <p>
          Shoot it on your phone, finish it on your PC. Pair the two once by matching a six-digit
          code, and images then travel straight between them, encrypted.
        </p>
        <p>It works the other way too. There is no account and no cloud in the middle.</p>
      </Split>

      <Split
        id="text-title"
        numeral="03"
        label="Copy text"
        title={
          <>
            The words in your screenshot, <em className="text-accent-ink">ready to paste.</em>
          </>
        }
        demo={<TextDemo />}
      >
        <p>
          On-device text recognition makes the writing in any capture selectable. Drag across it and
          press <Keys keys={['Ctrl', 'C']} size="sm" />, or copy all of it at once.
        </p>
        <p>The button on the left really copies. Paste it somewhere and see.</p>
      </Split>

      <Split
        id="balance-title"
        numeral="04"
        label="Balance and export"
        title={
          <>
            Framed evenly, <em className="text-accent-ink">sized for where it is going.</em>
          </>
        }
        demo={
          <div className="mock-window p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                {
                  name: 'X post',
                  size: '1600 × 900',
                  bg: 'linear-gradient(135deg,#f7c6a3,#ee8f63)',
                  ratio: '16 / 9',
                },
                {
                  name: 'LinkedIn',
                  size: '1200 × 1200',
                  bg: 'linear-gradient(135deg,#cfd8ea,#9fb2d6)',
                  ratio: '1 / 1',
                },
                {
                  name: 'Docs',
                  size: '2x PNG',
                  bg: 'linear-gradient(135deg,#ece4d6,#d8cdbb)',
                  ratio: '4 / 3',
                },
              ].map((p) => (
                <figure key={p.name} className="rounded-xl bg-surface-2 p-3">
                  <div
                    className="grid place-items-center rounded-lg"
                    style={{ background: p.bg, aspectRatio: p.ratio }}
                  >
                    <div className="h-[56%] w-[66%] rounded-md bg-[#fffdf9] shadow-[0_12px_22px_-10px_rgb(60_30_15/0.45)]" />
                  </div>
                  <figcaption className="mt-2.5 flex items-center justify-between text-[13px]">
                    <span className="font-semibold text-ink">{p.name}</span>
                    <span className="font-mono text-[11.5px] text-ink-3">{p.size}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        }
        flip
      >
        <p>
          {APP_NAME} trims the dead borders, sets padding in proportion to what is left and samples
          a background from the edges, so it never clashes with the window it frames.
        </p>
        <p>
          Then pick X, LinkedIn, Instagram, YouTube or your own size. PNG, JPEG or WebP at 1x, 2x or
          3x, or straight to the clipboard.
        </p>
      </Split>

      {/* Price */}
      <section aria-labelledby="price-title" className="container-page py-20 md:py-28">
        <div className="mock-window grid gap-10 p-8 md:grid-cols-2 md:p-12">
          <div>
            <p className="section-mark">
              <b>—</b>
              Pricing
            </p>
            <h2 id="price-title" className="display-2 mt-5">
              Free, with every feature. Pro is <em className="text-accent-ink">{LICENSE_PRICE}</em>,
              once.
            </h2>
          </div>
          <div className="flex flex-col justify-end">
            <p className="text-lg leading-relaxed text-ink-2">
              Pro removes the watermark, adds your own brand mark, lifts the limits on presets and
              batch, and includes a year of updates. No subscription.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/download"
                className="btn-ember inline-flex h-12 items-center justify-center gap-2 rounded-xl px-6 font-semibold transition-[background-color,box-shadow]"
              >
                <Download className="size-4" aria-hidden="true" />
                Download free
              </Link>
              <Link
                href="/pricing"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-line px-6 font-semibold text-ink transition-colors hover:border-ink-3"
              >
                See pricing
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
