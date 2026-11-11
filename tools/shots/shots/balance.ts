import { openDesktop, screenshotPng, settle } from '../lib/desktop.ts';
import type { ShotDef } from './types.ts';

/**
 * balance: the desktop editor right after a capture with uneven desktop borders. The Style tab is the first
 * thing the app shows, with Background on Auto, the padding slider in view and the already balanced result on
 * the canvas. Nothing is clicked: this is the zero-decision first impression the UX bar asks for.
 */
export const balance: ShotDef = {
  name: 'balance',
  async run({ browser, theme }) {
    const { context, page } = await openDesktop(browser, 'editor', { theme, expectFound: 0 });
    try {
      await page.getByRole('tab', { name: 'Style' }).click();
      // Park the pointer on the padding slider so it shows its hover state, as it would while being adjusted.
      const slider = page.getByRole('slider', { name: /padding/i }).first();
      if (await slider.count()) await slider.hover();
      await settle(page);
      return await screenshotPng(page);
    } finally {
      await context.close();
    }
  },
};
