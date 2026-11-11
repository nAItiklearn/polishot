import path from 'node:path';
import { test } from '@playwright/test';
import { PAGES } from './pages';

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
  for (const { path: route, name } of PAGES) {
    test(`${name} ${viewport.name}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        isMobile: viewport.isMobile,
        hasTouch: viewport.isMobile,
      });
      const page = await context.newPage();
      await page.goto(route);
      await page.addStyleTag({ content: '.offscreen-auto, footer { content-visibility: visible !important; }' });
      await page.evaluate(() => document.fonts.ready);
      // Walk down the page so every live background near the viewport starts and draws a frame.
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < total; y += 700) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await page.waitForTimeout(900);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, `${name}-${viewport.name}.png`), fullPage: true });
      await context.close();
    });
  }
}
