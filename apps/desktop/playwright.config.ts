import { defineConfig, devices } from '@playwright/test';

/**
 * Screenshots and flows for the preview window, run against the dev server in mock mode
 * (`/?mock=1`, see src/shared/mock/mockBackend.ts). The window is 1040 x 680, like the real one.
 * Run: pnpm --filter @polishot/desktop shots
 */
const PORT = 1421;

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/artifacts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1040, height: 680 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1040, height: 680 } } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
