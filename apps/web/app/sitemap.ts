import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

const PATHS = [
  { path: '/', priority: 1 },
  { path: '/features', priority: 0.8 },
  { path: '/pricing', priority: 0.8 },
  { path: '/download', priority: 0.8 },
  { path: '/changelog', priority: 0.5 },
  { path: '/editor', priority: 0.5 },
  { path: '/privacy', priority: 0.3 },
  { path: '/terms', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map(({ path, priority }) => ({
    url: `${SITE_URL}${path === '/' ? '' : path}`,
    priority,
  }));
}
