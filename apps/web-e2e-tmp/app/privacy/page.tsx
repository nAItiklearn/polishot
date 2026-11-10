import type { Metadata } from 'next';
import { APP_NAME } from '@polishot/brand';
import { LegalPage } from '@/components/legal';
import { GITHUB_URL } from '@/lib/site';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Privacy',
  description: `How ${APP_NAME} and this website handle your data. The short version: your screenshots stay on your device.`,
  path: '/privacy',
});

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Privacy"
      title="Your screenshots stay on your device."
      lead={`This page says what ${APP_NAME} and this website do with your data, in plain words.`}
    >
      <h2>What the apps do with your screenshots</h2>
      <p>
        Capture, balancing, redaction, text recognition and export all run on your device. Your images are
        not uploaded to us or to anyone else.
      </p>
      <ul>
        <li>
          On Windows, text recognition uses the OCR built into Windows. On Android, it uses an on-device
          model that ships with the app.
        </li>
        <li>The text found in your screenshots is never logged.</li>
      </ul>

      <h2>What is stored on your device</h2>
      <ul>
        <li>
          <strong>History.</strong> Captures and their editable settings are saved so you can reopen them.
          On Windows they are in a history folder under <code>%LOCALAPPDATA%\{APP_NAME}</code>. On Android
          they are in the app&apos;s private storage.
        </li>
        <li>
          <strong>Search index.</strong> The text recognised in a capture is stored next to it so history
          can be searched. It stays on your device.
        </li>
        <li>
          <strong>Deleting.</strong> Delete one capture, or clear all history, from inside the app. On
          Windows you can also delete the folder. Uninstalling the Android app removes its data.
        </li>
        <li>
          <strong>Settings and license key.</strong> Stored on your device, in Windows Credential Manager
          and in Android Keystore-backed storage.
        </li>
      </ul>

      <h2>Accounts and telemetry</h2>
      <p>
        There is no account. The apps send no telemetry by default, and they do not need an internet
        connection to work. If crash reports or usage statistics are ever added, they will be opt-in and
        listed here first.
      </p>

      <h2>Quick send</h2>
      <p>
        Quick send moves images between your PC and your phone over your local network. The devices find
        each other on that network, pair by comparing a six-digit code you confirm on both screens, and then
        send images directly to each other, encrypted. No server of ours is involved, and a device that has
        not been paired is refused.
      </p>

      <h2>Licenses and purchases</h2>
      <p>
        A license key contains a hash of the email address it was issued to, not the address itself. The
        app checks the key on your device, so activating it sends nothing.
      </p>
      <p>
        Licenses are not on sale yet. When they are, this section will name the payment provider and say
        what is kept about a purchase. At a minimum, that is the email address a key was issued to.
      </p>

      <h2>This website</h2>
      <ul>
        <li>No tracking cookies and no analytics scripts.</li>
        <li>
          <strong>Visitor counter.</strong> When it is switched on, the site shows how many different people
          have visited. It counts a one-way hash of your IP address, your browser string and a secret salt, kept
          in a structure that only estimates a total and cannot list who is in it. The address itself is not
          stored or logged, no cookie is set, and a flag in your tab&apos;s session storage stops it counting
          you twice in one visit.
        </li>
        <li>
          Your theme choice (system, light or dark) is saved in your browser&apos;s local storage under{' '}
          <code>ps-theme</code>. It never leaves your browser.
        </li>
        <li>
          The web editor processes an image inside your browser tab. The image is not uploaded.
        </li>
        <li>Fonts are served from this site. There are no third-party font or script requests.</li>
        <li>
          The site is hosted on Vercel, which keeps standard server logs (IP address, page requested, user
          agent) for security and operations.
        </li>
        <li>
          Download buttons go to GitHub Releases. GitHub&apos;s own privacy policy applies once you are
          there.
        </li>
      </ul>

      <h2>Questions</h2>
      <p>
        There is no private contact address yet. Open an issue on{' '}
        <a href={`${GITHUB_URL}/issues`} rel="noopener noreferrer" target="_blank">
          GitHub
        </a>{' '}
        and do not include anything private in it.
      </p>
    </LegalPage>
  );
}
