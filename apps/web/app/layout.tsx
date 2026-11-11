import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { APP_NAME, palette } from '@polishot/brand';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { DESCRIPTION, SITE_URL, TAGLINE } from '@/lib/site';
import './globals.css';

// Display: Cormorant Garamond, variable weight, with a true italic. Set bold; the italic carries the accent.
const serif = localFont({
  src: [
    {
      path: '../node_modules/@fontsource-variable/cormorant-garamond/files/cormorant-garamond-latin-wght-normal.woff2',
      weight: '300 700',
      style: 'normal',
    },
    {
      path: '../node_modules/@fontsource-variable/cormorant-garamond/files/cormorant-garamond-latin-wght-italic.woff2',
      weight: '300 700',
      style: 'italic',
    },
  ],
  variable: '--font-serif-face',
  display: 'swap',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
  adjustFontFallback: 'Times New Roman',
});

// Body and UI: Instrument Sans, variable weight.
const sans = localFont({
  src: '../node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2',
  weight: '400 700',
  variable: '--font-sans-face',
  display: 'swap',
  fallback: ['Segoe UI Variable Text', 'Segoe UI', 'system-ui', 'sans-serif'],
  adjustFontFallback: 'Arial',
});

// Geist Mono is only used for keys and code inside the demos, so it is not preloaded and only the
// regular weight is shipped.
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
  // The site has one theme: light.
  colorScheme: 'light',
  themeColor: palette.light.bg,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
      className={`${sans.variable} ${geistMono.variable} ${serif.variable}`}
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
