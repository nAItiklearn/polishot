import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;
const PREVIEW_PORT = 5198;

export default defineConfig({
  testDir: './e2e',
  // Artifacts go in a sub-folder so the hand-curated screenshots in test-results/ survive between runs.
  outputDir: './test-results/artifacts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'pnpm exec vite playground',
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // The production build, used by the frame-rate test: dev-mode React renders everything twice.
      command: `pnpm exec vite build playground && pnpm exec vite preview playground --port ${PREVIEW_PORT} --strictPort`,
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
