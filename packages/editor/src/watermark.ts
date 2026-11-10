/**
 * The "Made with" watermark is drawn on exports and on the canvas only when the app is not licensed.
 * Fails closed: anything other than the boolean `true` counts as unlicensed.
 */
export function shouldWatermark(licensed: boolean): boolean {
  return licensed !== true;
}

export interface WatermarkLayout {
  fontSize: number;
  /** Distance from the right and bottom canvas edges. */
  margin: number;
}

/** Size and placement of the watermark for an output canvas, bottom-right, scaled to stay subtle. */
export function watermarkLayout(width: number, height: number): WatermarkLayout {
  const fontSize = Math.min(30, Math.max(11, Math.round(Math.min(width, height) * 0.02)));
  return { fontSize, margin: Math.round(fontSize * 1.1) };
}
