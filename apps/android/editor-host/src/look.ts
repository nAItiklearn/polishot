import type { EditorDoc } from '@polishot/editor';
import { MAX_LOOK_JSON_CHARS } from './payload';

/*
 * A "look" is the reusable styling of a document: padding, background, corner radius, shadow, frame, canvas preset
 * and custom size. Android remembers the look of the last document the user edited and hands it back as JSON when
 * a batch run starts, so a batch of shared images comes out the way the user last styled one.
 */

export type LookPatch = Partial<Pick<EditorDoc, 'padding' | 'background' | 'radius' | 'shadow' | 'frame' | 'preset' | 'custom'>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Turns the stored look JSON into a patch for `editor.update`. The editor validates the result again; this only
 * drops what must not be copied between images:
 *  - an "auto" background, because its colours were derived from the previous image's edges (each image computes
 *    its own on load);
 *  - a custom size unless the look really uses the custom preset.
 * Returns null for anything that is not a usable look.
 */
export function lookToPatch(lookJson: string | undefined): LookPatch | null {
  if (!lookJson || lookJson.length > MAX_LOOK_JSON_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(lookJson);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const patch: Record<string, unknown> = {};
  for (const key of ['padding', 'radius', 'shadow'] as const) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v)) patch[key] = v;
  }
  if (typeof raw.frame === 'string') patch.frame = raw.frame;
  if (typeof raw.preset === 'string') patch.preset = raw.preset;
  if (raw.preset === 'custom' && isRecord(raw.custom)) patch.custom = raw.custom;
  if (isRecord(raw.background) && raw.background.type !== 'auto') patch.background = raw.background;

  return Object.keys(patch).length > 0 ? (patch as LookPatch) : null;
}
