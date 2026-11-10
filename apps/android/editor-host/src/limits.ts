/*
 * Free-tier limits from docs/CONTRACTS.md section 5b. Everything else (every capture, edit, redact, OCR and
 * export feature) works for Free users; only the watermark and these two numbers differ from Pro.
 */

/** Saved looks (user presets) a Free user can keep. */
export const FREE_SAVED_LOOKS = 3;

/** Images per batch beautify run for Free users. Android also enforces this before the page is told. */
export const FREE_BATCH_IMAGES = 5;

/** Technical ceiling for everyone, so one run cannot queue thousands of decodes. */
export const MAX_SAVED_LOOKS = 50;

export function canSaveAnotherLook(currentCount: number, pro: boolean): boolean {
  if (currentCount >= MAX_SAVED_LOOKS) return false;
  return pro || currentCount < FREE_SAVED_LOOKS;
}

export function batchLimit(pro: boolean): number {
  return pro ? 100 : FREE_BATCH_IMAGES;
}
