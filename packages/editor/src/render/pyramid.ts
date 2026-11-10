/**
 * Lazily built chain of half-size copies of the screenshot, used only for drawing on screen. Drawing a 4K
 * capture into a ~1000px canvas straight from the original needs either a slow high-quality resampler or
 * produces shimmering. Halving is an exact 2x2 average at the fastest resampler setting, and the chain is
 * built once, on demand. Exports and pixel effects always use the original image.
 */
export class ImagePyramid {
  private readonly levels: { element: CanvasImageSource; width: number; height: number }[];

  constructor(
    source: CanvasImageSource,
    readonly width: number,
    readonly height: number,
  ) {
    this.levels = [{ element: source, width, height }];
  }

  /**
   * The smallest level that still has at least `neededPx` pixels on the longest side (the size the whole
   * image is drawn at, in device pixels). Returns the level's element and its size.
   */
  pick(neededPx: number): { element: CanvasImageSource; width: number; height: number; level: number } {
    const longest = Math.max(this.width, this.height);
    let want = 0;
    while (want < 6 && longest / 2 ** (want + 1) >= neededPx && longest / 2 ** (want + 1) >= 64) want++;
    for (let l = this.levels.length; l <= want; l++) {
      const prev = this.levels[l - 1]!;
      const w = Math.max(1, Math.round(prev.width / 2));
      const h = Math.max(1, Math.round(prev.height / 2));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) break;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(prev.element, 0, 0, w, h);
      this.levels.push({ element: canvas, width: w, height: h });
    }
    const level = Math.min(want, this.levels.length - 1);
    return { ...this.levels[level]!, level };
  }
}
