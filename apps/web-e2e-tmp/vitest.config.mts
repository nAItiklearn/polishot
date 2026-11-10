import { defineConfig } from 'vitest/config';

// Unit tests cover the pure helpers in lib/. Browser tests live in e2e/ and run with Playwright.
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
  },
});
