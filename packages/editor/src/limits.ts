/**
 * Free-tier limits (CONTRACTS section 5b). Free keeps every editing feature; only these numbers differ.
 * Fails closed: anything other than the boolean `true` counts as Free.
 */

/** Saved user presets ("looks") a Free user may keep. */
export const FREE_PRESET_LIMIT = 3;

/** Images per batch-beautify run for a Free user. */
export const FREE_BATCH_LIMIT = 5;

/** How many saved presets are allowed: 3 for Free, unlimited (Infinity) for Pro. */
export function presetLimit(pro: boolean): number {
  return pro === true ? Infinity : FREE_PRESET_LIMIT;
}

/** How many images one batch run may process: 5 for Free, unlimited (Infinity) for Pro. Hosts enforce it. */
export function batchLimit(pro: boolean): number {
  return pro === true ? Infinity : FREE_BATCH_LIMIT;
}
