import type { Metadata } from 'next';
import { APP_NAME } from '@polishot/brand';
import { TAGLINE } from './site';

interface PageMeta {
  title: string;
  description: string;
  /** Site-relative path, e.g. "/pricing". Becomes the canonical URL. */
  path: string;
}

/**
 * The share card is app/opengraph-image.tsx. A page that sets its own `openGraph` replaces the layout's
 * object entirely (Next does not deep-merge it), which drops the file-based image, so it is repeated here.
 */
const SHARE_IMAGE = {
  url: '/opengraph-image',
  width: 1200,
  height: 630,
  type: 'image/png',
  alt: `${APP_NAME}: ${TAGLINE}`,
};

/** Per-page title, description, canonical URL and social tags. */
export function pageMetadata({ title, description, path }: PageMeta): Metadata {
  const fullTitle = `${title} | ${APP_NAME}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      siteName: APP_NAME,
      title: fullTitle,
      description,
      url: path,
      images: [SHARE_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images: [{ url: SHARE_IMAGE.url, alt: SHARE_IMAGE.alt }],
    },
  };
}
