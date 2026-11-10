import path from 'node:path';
import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Content-Security-Policy.
 *
 * Everything is same-origin. Two things are loosened on purpose:
 *  - script-src 'unsafe-inline': the pages are statically rendered, so Next's inline flight-data
 *    scripts (and our 6-line theme bootstrap) cannot carry a per-request nonce.
 *  - style-src 'unsafe-inline': React style attributes and the Radix scroll-lock <style> tag.
 * 'unsafe-eval' is only added in development (React refresh needs it). The /editor route also gets
 * 'wasm-unsafe-eval' and blob workers for the in-browser OCR engine; no other page does.
 */
function contentSecurityPolicy({ editor }: { editor: boolean }): string {
  const script = ["'self'", "'unsafe-inline'"];
  if (isDev) script.push("'unsafe-eval'");
  if (editor) script.push("'wasm-unsafe-eval'");

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': script,
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'worker-src': editor ? ["'self'", 'blob:'] : ["'none'"],
    'manifest-src': ["'self'"],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  // My own builds and tests use NEXT_DIST_DIR so they never overwrite a dev server running from .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@polishot/brand', '@polishot/editor', '@polishot/redact'],
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
  images: {
    formats: ['image/avif', 'image/webp'],
  },
  async headers() {
    return [
      {
        source: '/editor',
        headers: [
          ...securityHeaders,
          { key: 'Content-Security-Policy', value: contentSecurityPolicy({ editor: true }) },
        ],
      },
      {
        // Every route except /editor.
        source: '/((?!editor$).*)',
        headers: [
          ...securityHeaders,
          { key: 'Content-Security-Policy', value: contentSecurityPolicy({ editor: false }) },
        ],
      },
    ];
  },
};

export default nextConfig;
