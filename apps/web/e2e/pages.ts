/** Every statically rendered page. Shared by the e2e specs. */
export const PAGES = [
  { path: '/', name: 'home' },
  { path: '/features', name: 'features' },
  { path: '/pricing', name: 'pricing' },
  { path: '/changelog', name: 'changelog' },
  { path: '/download', name: 'download' },
  { path: '/privacy', name: 'privacy' },
  { path: '/terms', name: 'terms' },
  { path: '/editor', name: 'editor' },
] as const;

