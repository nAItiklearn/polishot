import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { APP_NAME, WATERMARK_TEXT } from '@polishot/brand';
import { BuyButton } from '@/components/buy-button';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ShaderBand } from '@/components/shaders/shader-band';
import { FREE_LIMITS, LICENSE_PRICE } from '@/lib/site';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Pricing',
  description: `${APP_NAME} is free with every feature and a small watermark. Pro is ${LICENSE_PRICE}, once: no watermark, your own brand mark, unlimited presets and batch, and a year of updates.`,
  path: '/pricing',
});

const FREE_POINTS = [
  'Every capture, redaction, text and export tool',
  'Windows and Android',
  `A small "${WATERMARK_TEXT}" mark on exports`,
  `${FREE_LIMITS.presets} saved presets`,
  `Batch beautify, up to ${FREE_LIMITS.batchImages} images at a time`,
];

const PRO_POINTS = [
  'No watermark on exports',
  'Your own brand mark: a logo or a line of text',
  'Unlimited saved presets',
  'Unlimited batch beautify',
  'A year of updates, offline activation',
];

/*
 * TODO(owner): confirm the device limit and any team terms, then update the second answer here and the
 * license section of /terms. Until then the copy only states what the key format does: it is not tied
 * to a device.
 */
const FAQ = [
  {
    q: 'Do I need to be online to activate a license?',
    a: 'No. A license key is checked on your device against a public key built into the app. Activating it sends nothing anywhere, so it works offline.',
  },
  {
    q: 'How many devices can I use it on?',
    a: 'A key is not tied to a device. It is meant for one person across their own computers and phones. Team terms will be on the Terms page before Pro goes on sale.',
  },
  {
    q: 'What does the free version leave out?',
    a: `The watermark, the custom brand mark, and two limits: ${FREE_LIMITS.presets} saved presets and ${FREE_LIMITS.batchImages} images per batch. Every tool, preset and export format is in it, on both Windows and Android.`,
  },
  {
    q: 'Can I get a refund?',
    a: 'Refund terms are not final yet. They will be published here before Pro goes on sale.',
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHeader eyebrow="Pricing" title="Free, or pay once." variant="gold" intensity={0.8} offset={[0, 0.12]}>
        Both versions have every feature. Pro removes the watermark and the limits.
      </PageHeader>

      <section aria-label="Plans" className="container-page py-16 md:py-24">
        <div className="grid gap-6 md:grid-cols-2 md:gap-8">
          <div className="flex flex-col rounded-lg border border-line bg-surface p-8 shadow-low md:p-12">
            <h2 className="eyebrow">Free</h2>
            <p className="mt-8 font-display text-[clamp(4rem,3rem+4vw,6.5rem)] leading-none tracking-[-0.04em]">
              $0
            </p>
            <p className="mt-4 text-ink-2">Everything, with a small watermark.</p>
            <ul className="mt-10 text-[15px]">
              {FREE_POINTS.map((point) => (
                <li key={point} className="border-t border-line py-3.5 text-ink">
                  {point}
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-10">
              <div className="min-h-24">
                <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
                  <Link href="/download">Download free</Link>
                </Button>
              </div>
            </div>
          </div>

          <ShaderBand
            variant="gold"
            intensity={0.55}
            offset={[0, 0.2]}
            scrim="bottom"
            className="flex flex-col rounded-lg border border-line shadow-high"
          >
            <div className="flex flex-1 flex-col p-8 md:p-12">
              <h2 className="eyebrow">Pro</h2>
              <p className="mt-8 flex items-baseline gap-3">
                <span className="font-display text-[clamp(4rem,3rem+4vw,6.5rem)] leading-none tracking-[-0.04em]">
                  {LICENSE_PRICE}
                </span>
                <span className="text-ink-2">one-time</span>
              </p>
              <p className="mt-4 text-ink-2">The same app, without the watermark or the limits.</p>
              <ul className="mt-10 text-[15px]">
                {PRO_POINTS.map((point) => (
                  <li key={point} className="border-t border-line py-3.5 text-ink">
                    {point}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-10">
                <div className="min-h-24">
                  <BuyButton />
                </div>
              </div>
            </div>
          </ShaderBand>
        </div>

        <div className="mt-12 grid gap-4 border-t border-line pt-10 md:grid-cols-12 md:gap-12">
          <h2 className="eyebrow md:col-span-4">Updates</h2>
          <p className="max-w-[56ch] text-lg text-ink md:col-span-8">
            Keep every version released within a year of purchase, forever.
            <span className="mt-3 block text-[15px] text-ink-2">
              Versions released after that year run as Free, and say so on screen. The last version your key
              covers stays Pro for good.
            </span>
          </p>
        </div>
      </section>

      <section aria-labelledby="faq-title" className="container-page">
        <div className="grid gap-10 border-t border-line pb-24 pt-16 md:grid-cols-12 md:gap-16 md:pb-36 md:pt-24">
          <h2 id="faq-title" className="display-2 md:col-span-4">
            Questions
          </h2>
          <div className="md:col-span-8">
            {FAQ.map((item, i) => (
              <details key={item.q} className={`group ${i === 0 ? '' : 'border-t'} border-line py-1`}>
                <summary className="flex min-h-14 cursor-pointer items-center justify-between gap-6 rounded-md py-3 text-[17px] font-medium text-ink">
                  {item.q}
                  <ChevronDown
                    className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <p className="max-w-[60ch] pb-5 pr-10 text-ink-2">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
