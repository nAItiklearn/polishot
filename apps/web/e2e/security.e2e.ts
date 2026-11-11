import { expect, test } from '@playwright/test';
import { PAGES } from './pages';

test.describe('security headers', () => {
  for (const { path } of PAGES) {
    test(`${path} sends the hardening headers`, async ({ request }) => {
      const res = await request.get(path);
      const h = res.headers();

      const csp = h['content-security-policy'] ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).not.toMatch(/https?:\/\//); // nothing remote is allowed

      // 'wasm-unsafe-eval' (for the in-browser OCR engine) is granted to /editor and nowhere else.
      if (path === '/editor') expect(csp).toContain("'wasm-unsafe-eval'");
      else expect(csp).not.toContain('wasm-unsafe-eval');

      expect(h['strict-transport-security']).toMatch(/max-age=\d{7,}/);
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(h['permissions-policy']).toContain('camera=()');
      expect(h['permissions-policy']).toContain('microphone=()');
      expect(h['permissions-policy']).toContain('geolocation=()');
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['x-powered-by']).toBeUndefined();
    });
  }
});

test.describe('runtime hygiene', () => {
  for (const { path } of PAGES) {
    test(`${path} makes only same-origin requests and logs no errors`, async ({ page, baseURL }) => {
      const foreign: string[] = [];
      const problems: string[] = [];
      page.on('request', (req) => {
        const url = req.url();
        if (!url.startsWith(baseURL!) && !url.startsWith('data:') && !url.startsWith('blob:')) {
          foreign.push(url);
        }
      });
      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`${msg.type()}: ${msg.text()}`);
      });
      page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);

      expect(foreign, 'third-party requests').toEqual([]);
      expect(problems, 'console errors and warnings').toEqual([]);
    });
  }

  test('no cookies are set while browsing every page', async ({ page, context }) => {
    for (const { path } of PAGES) await page.goto(path);
    expect(await context.cookies()).toEqual([]);
  });
});
