import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { GeistSans } from 'geist/font/sans';
import { APP_NAME, palette } from '@polishot/brand';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { DESCRIPTION, SITE_URL, TAGLINE } from '@/lib/site';
import './globals.css';

const instrumentSerif = localFont({
  src: [
    {
      path: '../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2',
      weight: '400',
      style: 'italic',
    },
  ],
  variable: '--font-instrument-serif',
  // 'optional': if the (preloaded) font misses its first-paint window the page keeps the metric-matched
  // fallback instead of swapping later, so a 100px headline can never jump.
  display: 'optional',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
  adjustFontFallback: 'Times New Roman',
});

// Geist Mono is only used for small labels, keys and code, so it is not preloaded and only the
// regular weight is shipped (the variable file is 20 KB larger).
const geistMono = localFont({
  src: '../node_modules/geist/dist/fonts/geist-mono/GeistMono-Regular.woff2',
  weight: '400',
  variable: '--font-geist-mono',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${APP_NAME} | ${TAGLINE}`, template: `%s | ${APP_NAME}` },
  description: DESCRIPTION,
  applicationName: APP_NAME,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: APP_NAME,
    title: `${APP_NAME} | ${TAGLINE}`,
    description: DESCRIPTION,
    url: '/',
  },
  twitter: { card: 'summary_large_image', title: `${APP_NAME} | ${TAGLINE}`, description: DESCRIPTION },
};

export const viewport: Viewport = {
  // The site is dark only.
  colorScheme: 'dark',
  themeColor: palette.dark.bg,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${GeistSans.variable} ${geistMono.variable} ${instrumentSerif.variable}`}
    >
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-bg"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" tabIndex={-1} className="outline-none">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
