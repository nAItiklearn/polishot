import type { Page } from '@playwright/test';
import { openDesktop, screenshotPng, settle } from '../lib/desktop.ts';
import type { ShotDef } from './types.ts';

/** Social preset picked on the canvas size control (matched against the option's label). */
const PRESET = /^X post/;

/**
 * export: a dashboard screenshot resized to a 16:9 social preset on the Style tab, then the Export tab with
 * PNG and 2x chosen. The canvas shows the 16:9 result, the panel the format, scale and output size.
 */
export const exportShot: ShotDef = {
  name: 'export',
  async run({ browser, theme }) {
    const { context, page } = await openDesktop(browser, 'dashboard', { theme, expectFound: 0 });
    try {
      await choosePreset(page);
      await page.getByRole('tab', { name: 'Export' }).click();
      await page.getByRole('button', { name: 'Scale 2x' }).click();
      await page.getByRole('button', { name: 'PNG', exact: true }).click();
      await page.mouse.move(10, 10);
      await settle(page);
      // The panel's size readout must agree with the preset: X post is 1600 x 900, doubled at 2x.
      const size = (await page.getByRole('status', { name: 'Output size' }).innerText()).replace(/\s/g, '');
      if (size !== '3200×1800') throw new Error(`export size readout is "${size}", expected 3200×1800 for the X post preset at 2x`);
      return await screenshotPng(page);
    } finally {
      await context.close();
    }
  },
};

async function choosePreset(page: Page): Promise<void> {
  // If the Export tab ever lists the presets itself (as chips or radios), use that: it is what the shot is for.
  await page.getByRole('tab', { name: 'Export' }).click();
  const inline = page.locator('.pv-inspector').getByRole('button', { name: PRESET }).or(page.locator('.pv-inspector').getByRole('radio', { name: PRESET }));
  if (await inline.count()) {
    await inline.first().click();
    await settle(page);
    return;
  }
  // Today the presets live in the Style tab's canvas size control.
  await page.getByRole('tab', { name: 'Style' }).click();
  const select = page.getByRole('combobox', { name: /size/i });
  const labels = await select.locator('option').allTextContents();
  const label = labels.find((l) => PRESET.test(l));
  if (!label) throw new Error(`no preset matching ${PRESET} in: ${labels.join(', ')}`);
  await select.selectOption({ label });
  await settle(page);
}
