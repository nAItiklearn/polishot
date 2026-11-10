import type { Metadata } from 'next';
import Link from 'next/link';
import { APP_NAME, WATERMARK_TEXT } from '@polishot/brand';
import { LegalPage } from '@/components/legal';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Terms',
  description: `The terms for using ${APP_NAME}, its licenses and this website.`,
  path: '/terms',
});

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Terms"
      title="The terms, in plain words."
      lead={`These are the terms for using ${APP_NAME} and this website. If a sentence here is unclear, that is a bug in the text.`}
    >
      <h2>Using the software</h2>
      <p>
        {APP_NAME} is free to use, with every feature. Free exports carry a small &quot;{WATERMARK_TEXT}
        &quot; mark. A license key removes it.
      </p>
      <p>
        You own your screenshots and everything you export. We claim no rights to them, and we never
        receive them.
      </p>

      <h2>Pro</h2>
      <ul>
        <li>Pro is a one-time payment, not a subscription.</li>
        <li>
          Pro removes the watermark, lets you use your own brand mark, and lifts the limits on saved presets
          and batch beautify.
        </li>
        <li>
          It includes a year of updates: you keep every version released within a year of purchase, forever.
          Versions released later run as Free. The last version your key covers stays Pro.
        </li>
        <li>
          A key is not tied to a device. It is meant for one person across their own computers and phones.
          Keep it private, and do not publish or resell it.
        </li>
        <li>
          Refunds: the refund terms are not final yet. They will be written here before Pro goes on sale.
        </li>
      </ul>
      <p>
        See <Link href="/pricing">pricing</Link> for the current price. Pro is not on sale yet.
      </p>

      <h2>Redaction is a convenience</h2>
      <p>
        Automatic redaction reads your screenshot with text recognition and covers what looks like an
        email address, card number, IP address or API key. It can miss text, misread it, or cover the wrong
        thing. Look at every image before you share it. What you publish is your responsibility.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use {APP_NAME} to capture or share content you have no right to capture or share, or to
        break the law. Do not try to use the software to attack other people&apos;s devices or networks,
        including through quick send.
      </p>

      <h2>No warranty</h2>
      <p>
        The software is provided as it is, without warranties of any kind. To the extent the law allows,
        our liability for any claim about the software is limited to the amount you paid for it.
      </p>

      <h2>This website</h2>
      <p>
        The site is information about the software. Its content is provided as it is and may change. See the{' '}
        <Link href="/privacy">privacy page</Link> for what the site does and does not collect.
      </p>

      <h2>Changes and governing law</h2>
      <p>
        We may change these terms. The date at the bottom shows when they last changed. The governing law
        and venue are not decided yet and will be named here.
      </p>
    </LegalPage>
  );
}
