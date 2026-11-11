import type { Page } from '@playwright/test';
import { openDesktop, screenshotPng, settle } from '../lib/desktop.ts';
import type { ShotDef } from './types.ts';

/** First and last word of the line that gets selected (matched against the OCR word text). */
const LINE_FIRST = 'error[E0382]:';
const LINE_LAST = '`frames`';

/** Screen rectangle of the recognised-text span that starts / ends the line. */
async function wordRect(page: Page, text: string, occurrence = 0) {
  const spans = page.locator('.pe-word', { hasText: text });
  const handle = spans.nth(occurrence);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`no recognised word "${text}" on the canvas`);
  return box;
}

/**
 * ocr: a terminal screenshot with the Text tab open, so every recognised word is outlined on the canvas.
 * One line (the compiler error) is selected by dragging across it, as a user would, and the copy button is
 * pressed so the "Copied" state and the toast are on screen.
 */
export const ocr: ShotDef = {
  name: 'ocr',
  async run({ browser, theme }) {
    const { context, page } = await openDesktop(browser, 'terminal', { theme, expectFound: 0 });
    try {
      await page.getByRole('tab', { name: 'Text' }).click();
      await page.locator('.pe-word').first().waitFor();
      await settle(page);

      const first = await wordRect(page, LINE_FIRST);
      const last = await wordRect(page, LINE_LAST);
      const y = first.y + first.height / 2;
      await page.mouse.move(first.x + 1, y);
      await page.mouse.down();
      await page.mouse.move(last.x + last.width - 1, y, { steps: 14 });
      await page.mouse.up();
      await settle(page, 200);

      const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
      if (!selected.replace(/\s/g, '').includes('borrowofmovedvalue')) throw new Error(`the drag did not select the error line (selected: "${selected}")`);

      await page.getByRole('button', { name: /Copy all text|Copied/ }).click();
      await page.locator('.pv-toast').first().waitFor();
      await page.mouse.move(10, 10);
      await settle(page, 250);
      return await screenshotPng(page);
    } finally {
      await context.close();
    }
  },
};
