import { openDesktop, screenshotPng, settle } from '../lib/desktop.ts';
import type { ShotDef } from './types.ts';

/** Which cover the "apply" step uses: the panel's "Blur all" or "Bars" button. */
const COVER: 'Blur all' | 'Bars' = 'Bars';
/** The detection left uncovered, to show that every row is a switch. Matched against the row's label. */
const LEFT_VISIBLE = /IPv4/;

/**
 * redact: the Redact tab on a chat screenshot that contains an e-mail address, a card number, an IP address
 * and an API key. All four are found; the covers are applied with the panel's own button, then one row is
 * switched back off so the list shows both states.
 */
export const redact: ShotDef = {
  name: 'redact',
  async run({ browser, theme }) {
    const { context, page } = await openDesktop(browser, 'chat', { theme, expectFound: 4 });
    try {
      await page.getByRole('tab', { name: /^Redact/ }).click();
      const rows = page.getByRole('switch');
      await rows.first().waitFor();
      if ((await rows.count()) !== 4) throw new Error(`expected 4 detections in the Redact panel, found ${await rows.count()}`);
      await page.getByRole('button', { name: COVER, exact: true }).click();
      await settle(page);
      await rows.filter({ hasText: LEFT_VISIBLE }).click(); // toggles that one off again
      // Move the pointer off the list so no row shows a hover state.
      await page.mouse.move(10, 10);
      await settle(page);
      return await screenshotPng(page);
    } finally {
      await context.close();
    }
  },
};
