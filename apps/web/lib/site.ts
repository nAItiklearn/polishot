import { APP_NAME, SITE_URL as BRAND_SITE_URL, WATERMARK_TEXT } from '@polishot/brand';
import { parseCheckoutUrl, parseOrigin, parseRepo } from './url';

export { APP_NAME, WATERMARK_TEXT };

/** Public origin, used for canonical URLs, the sitemap and social cards. */
export const SITE_URL = parseOrigin(process.env.NEXT_PUBLIC_SITE_URL, BRAND_SITE_URL);

/** GitHub "owner/repo" that publishes releases. */
export const GITHUB_REPO = parseRepo(process.env.NEXT_PUBLIC_GITHUB_REPO, 'owner/polishot');
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

/** Pro price, one time (owner decision, docs/CONTRACTS.md section 5b). Shown on /pricing and the home page. */
export const LICENSE_PRICE = '$11';

/** Free-tier limits (docs/CONTRACTS.md section 5b). Pro removes them. */
export const FREE_LIMITS = { presets: 3, batchImages: 5 } as const;

/** Null while licenses are not on sale. When set, the pricing page shows a live buy link. */
export const CHECKOUT_URL = parseCheckoutUrl(process.env.NEXT_PUBLIC_CHECKOUT_URL);

/**
 * Release asset file names. The release workflow must upload files with exactly these names;
 * the download page links to /releases/latest/download/<name>.
 */
export const ASSETS = {
  windowsExe: `${APP_NAME}-Setup-x64.exe`,
  windowsMsi: `${APP_NAME}-x64.msi`,
  androidApk: `${APP_NAME}.apk`,
} as const;

export type AssetKey = keyof typeof ASSETS;

export function releaseAssetUrl(asset: AssetKey): string {
  return `${GITHUB_URL}/releases/latest/download/${ASSETS[asset]}`;
}

/** Shown on /privacy and /terms until a lawyer has reviewed them. Set to true to hide the notice. */
export const LEGAL_REVIEWED = false;
export const LEGAL_UPDATED = '10 November 2026';

export const NAV = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/changelog', label: 'Changelog' },
] as const;

/** The mobile menu has room for everything, including the download page and the web editor. */
export const MOBILE_NAV = [
  ...NAV,
  { href: '/download', label: 'Download' },
  { href: '/editor', label: 'Web editor' },
] as const;

export const FOOTER_LINKS = {
  product: [
    { href: '/features', label: 'Features' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/download', label: 'Download' },
    { href: '/changelog', label: 'Changelog' },
    { href: '/editor', label: 'Web editor' },
  ],
  legal: [
    { href: '/privacy', label: 'Privacy' },
    { href: '/terms', label: 'Terms' },
  ],
} as const;

export const TAGLINE = 'Screenshots, finished in about two seconds.';
export const DESCRIPTION = `${APP_NAME} turns a screenshot into a clean, shareable image in about two seconds. It balances the framing, covers emails, cards, IPs and API keys, copies the text, and exports. Free for Windows and Android.`;
