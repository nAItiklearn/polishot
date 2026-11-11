import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PAGES } from './pages';

async function scan(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  // Every rule on everything, except colour contrast inside [data-illustration]: the live demos draw mock
  // app screens, which WCAG 1.4.3 treats as text that is part of a picture. Their controls are still checked.
  const all = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  const contrast = await new AxeBuilder({ page })
    .withRules(['color-contrast'])
    .exclude('[data-illustration]')
    .analyze();
  const results = { violations: [...all.violations, ...contrast.violations] };
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
  }));
}

// The site has one theme (light paper), so there is one theme to check.
for (const { path, name } of PAGES) {
  test(`axe: ${name} has no violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.waitForTimeout(300);

    const violations = await scan(page);
    const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    // Stricter than the brief: nothing at all, including moderate and minor.
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
}

test('axe: the open mobile menu has no violations', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile only.');
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(400);
  expect(await scan(page)).toEqual([]);
});

test('axe: an opened FAQ answer has no violations', async ({ page }) => {
  await page.goto('/pricing');
  await page.locator('summary').first().click();
  expect(await scan(page)).toEqual([]);
});
