import path from 'node:path';
import { test } from '@playwright/test';
import { PAGES, THEMES } from './pages';

/**
 * Not an assertion test: it writes screenshots to test-results/screens/ so the design can be reviewed.
 * `pnpm e2e:shots`
 */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
] as const;

const OUT = path.join(__dirname, '..', 'test-results', 'screens');

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    for (const { path: route, name } of PAGES) {
      test(`${name} ${viewport.name} ${theme}`, async ({ browser }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          isMobile: viewport.isMobile,
          hasTouch: viewport.isMobile,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        await page.goto(route);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: path.join(OUT, `${name}-${viewport.name}-${theme}.png`),
          fullPage: true,
        });
        await context.close();
      });
    }
  }
}
