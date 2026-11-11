import { FREE_BATCH_LIMIT, FREE_PRESET_LIMIT, batchLimit as packageBatchLimit, presetLimit } from '@polishot/editor';

/*
 * Free-tier limits from docs/CONTRACTS.md section 5b. Everything else (every capture, edit, redact, OCR and
 * export feature) works for Free users; only the watermark and these two numbers differ from Pro. The numbers
 * come from @polishot/editor so every host (desktop, web, Android) agrees; Android also enforces the batch limit
 * natively before the page is told.
 */

/** Saved looks (user presets) a Free user can keep. */
export const FREE_SAVED_LOOKS = FREE_PRESET_LIMIT;

/** Images per batch beautify run for Free users. */
export const FREE_BATCH_IMAGES = FREE_BATCH_LIMIT;

/** Technical ceiling for everyone, so one run cannot queue thousands of decodes. */
export const MAX_SAVED_LOOKS = 50;

/** Technical ceiling of one Pro batch run (the native side applies the same number). */
export const PRO_BATCH_CEILING = 100;

export function canSaveAnotherLook(currentCount: number, pro: boolean): boolean {
  if (currentCount >= MAX_SAVED_LOOKS) return false;
  return currentCount < presetLimit(pro);
}

export function batchLimit(pro: boolean): number {
  return Math.min(PRO_BATCH_CEILING, packageBatchLimit(pro));
}
