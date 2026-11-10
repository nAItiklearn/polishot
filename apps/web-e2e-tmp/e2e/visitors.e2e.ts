import { expect, test } from '@playwright/test';

/**
 * Without UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN and VISITOR_SALT the counter is off: no pill, no
 * request, and the endpoint answers 404. (The enabled path is covered by unit tests in lib/visits.test.ts,
 * with fetch mocked, so no real Redis is needed.)
 */
test.describe('visitor counter, not configured', () => {
  test.skip(
    !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN && process.env.VISITOR_SALT),
    'Only meaningful while the counter is not configured.',
  );

  test('the pill is not rendered and nothing is requested', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', (r) => r.url().includes('/api/visits') && calls.push(r.method()));
    await page.goto('/');
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('visitor-pill')).toHaveCount(0);
    await expect(page.getByText(/\bvisitors?\b/i)).toHaveCount(0);
    expect(calls).toEqual([]);
    expect(await page.evaluate(() => window.sessionStorage.getItem('ps-visit'))).toBeNull();
  });

  test('the endpoint answers 404 to GET and POST and never fabricates a number', async ({ request }) => {
    for (const method of ['get', 'post'] as const) {
      const res = await request[method]('/api/visits', { headers: { 'sec-fetch-site': 'same-origin' } });
      expect(res.status(), method).toBe(404);
      expect(await res.json()).toEqual({ error: 'disabled' });
    }
  });
});
