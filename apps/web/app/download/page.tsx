import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Download } from 'lucide-react';
import { APP_NAME } from '@polishot/brand';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ASSETS, releaseAssetUrl, type AssetKey } from '@/lib/site';
import { latestRelease } from '@/lib/changelog';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Download',
  description: `Download ${APP_NAME} for Windows (.exe or .msi) or Android (.apk). Free, with every feature.`,
  path: '/download',
});

function Spec({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-line py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-8">
      <dt className="text-[15px] font-medium text-ink">{term}</dt>
      <dd className="text-[15px] text-ink-2">{children}</dd>
    </div>
  );
}

/** A real link when the file is hosted, otherwise a disabled button. Never a placeholder URL. */
function AssetButton({
  asset,
  primary,
  children,
}: {
  asset: AssetKey;
  primary?: boolean;
  children: ReactNode;
}) {
  const href = releaseAssetUrl(asset);
  const variant = primary ? 'primary' : 'outline';
  if (!href) {
    return (
      <Button size="lg" variant={variant} disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild size="lg" variant={variant}>
      <a href={href} rel="noopener noreferrer" download>
        {children}
      </a>
    </Button>
  );
}

export default function DownloadPage() {
  const release = latestRelease();
  const hosted = releaseAssetUrl('windowsExe') !== null;
  const pending = !hosted || !release || release.unreleased;

  return (
    <>
      <PageHeader
        eyebrow="Download"
        title="Get it for Windows or Android."
        variant="orbs"
        intensity={0.7}
      >
        Both are free, with every feature.
      </PageHeader>

      {pending ? (
        <div className="container-page pb-12">
          <p className="max-w-[68ch] rounded-md border border-line bg-surface-2 px-5 py-4 text-[15px] text-ink-2">
            {release
              ? `Version ${release.version} is not released yet. `
              : 'There is no release yet. '}
            The download buttons switch on when the first release is published.
          </p>
        </div>
      ) : null}

      <section id="windows" aria-labelledby="windows-title" className="container-page scroll-mt-24">
        <div className="grid gap-10 border-t border-line py-14 md:grid-cols-12 md:gap-16 md:py-20">
          <div className="md:col-span-4">
            <h2 id="windows-title" className="display-2">
              Windows
            </h2>
            <p className="mt-3 text-ink-3">Windows 10 or 11, 64-bit.</p>
          </div>

          <div className="md:col-span-8">
            <div className="flex flex-wrap gap-3">
              <AssetButton asset="windowsExe" primary>
                <Download aria-hidden="true" />
                Installer (.exe)
              </AssetButton>
              <AssetButton asset="windowsMsi">MSI package (.msi)</AssetButton>
            </div>
            <p className="mt-4 font-mono text-xs text-ink-3">
              {ASSETS.windowsExe} <span className="mx-1 opacity-60">/</span> {ASSETS.windowsMsi}
            </p>

            <dl className="mt-12">
              <Spec term="System">Windows 10 or 11, 64-bit.</Spec>
              <Spec term="Text recognition">
                Uses the OCR built into Windows, so it needs the language pack for the language you
                capture. Add one under Settings, Time and language, Language and region.
              </Spec>
              <Spec term="WebView2">
                Needs the Microsoft Edge WebView2 runtime, which comes with current versions of
                Windows 10 and 11.
              </Spec>
              <Spec term="SmartScreen">
                Until the installer is code-signed, Windows SmartScreen may say it protected your
                PC. Choose More info, then Run anyway. Only do that for a file you downloaded from
                this page.
              </Spec>
              <Spec term="Which one?">
                The .exe is the usual installer. The .msi is for managed PCs and scripted installs.
              </Spec>
            </dl>
          </div>
        </div>
      </section>

      <section id="android" aria-labelledby="android-title" className="container-page scroll-mt-24">
        <div className="grid gap-10 border-t border-line py-14 md:grid-cols-12 md:gap-16 md:py-20">
          <div className="md:col-span-4">
            <h2 id="android-title" className="display-2">
              Android
            </h2>
            <p className="mt-3 text-ink-3">Android 10 or later.</p>
          </div>

          <div className="md:col-span-8">
            <div className="flex flex-wrap gap-3">
              <AssetButton asset="androidApk" primary>
                <Download aria-hidden="true" />
                Download APK (.apk)
              </AssetButton>
            </div>
            <p className="mt-4 font-mono text-xs text-ink-3">{ASSETS.androidApk}</p>

            <dl className="mt-12">
              <Spec term="System">Android 10 (API 29) or later.</Spec>
              <Spec term="Installing">
                This is an APK from outside the Play Store. Your browser or file manager will ask
                you to allow installs from it, once.
              </Spec>
              <Spec term="Permissions">
                The capture bubble needs permission to display over other apps. Screen capture asks
                for permission each time you start it. Both are explained in the app before they are
                asked.
              </Spec>
            </dl>
          </div>
        </div>
      </section>
    </>
  );
}
