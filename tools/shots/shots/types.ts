import type { Browser } from '@playwright/test';
import type { Manifest } from '../lib/manifest.ts';
import type { Theme } from '../lib/desktop.ts';
import type { SampleMeta, SampleName } from '../samples/render.ts';

export interface ShotCtx {
  browser: Browser;
  manifest: Manifest;
  /** Colour scheme of the product UI in the app shots. */
  theme: Theme;
  samples: Record<SampleName, SampleMeta>;
}

export interface ShotDef {
  /** File stem, and the key in manifest.json. */
  name: string;
  /**
   * Produces the shot as a PNG whose aspect ratio matches the manifest entry. It may be rendered at any
   * larger resolution: capture.ts downsamples it to the exact manifest size.
   */
  run(ctx: ShotCtx): Promise<Buffer>;
}
