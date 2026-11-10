import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3107);
const baseURL = `http://localhost:${PORT}`;

/**
 * Tests run against the production build (`next build && next start`), which is what ships:
 * the real CSP, static HTML, and no dev overlay. With a server already running on E2E_PORT it is reused
 * (rebuild first if you changed code).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // Kept apart from test-results/screens, which Playwright must not clean.
  outputDir: './test-results/artifacts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/report' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    // Headless Chromium has no GPU; allow its software renderer so the WebGL backgrounds can run.
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
  },
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /shots\.e2e\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      testIgnore: /shots\.e2e\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      // Screenshots of every page at desktop and mobile widths, light and dark. Run with `pnpm e2e:shots`.
      name: 'shots',
      testMatch: /shots\.e2e\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
