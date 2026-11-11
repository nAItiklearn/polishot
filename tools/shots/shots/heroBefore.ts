import { readFileSync } from 'node:fs';
import { samplePng } from '../samples/render.ts';
import type { ShotDef } from './types.ts';

/**
 * hero-before: the raw capture, exactly as region capture would hand it over: uneven desktop borders, no
 * padding, no shadow, the e-mail address and the key legible. It is the untouched sample PNG (rendered at
 * 2x); capture.ts downsamples it to the manifest's 1200 x 900.
 */
export const heroBefore: ShotDef = {
  name: 'hero-before',
  async run() {
    return readFileSync(samplePng('settings'));
  },
};
