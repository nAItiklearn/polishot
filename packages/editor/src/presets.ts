import type { PresetId } from './types';

export interface PresetInfo {
  label: string;
  width?: number;
  height?: number;
}

export const PRESETS: Record<PresetId, PresetInfo> = {
  auto: { label: 'Auto' },
  x: { label: 'X post', width: 1600, height: 900 },
  linkedin: { label: 'LinkedIn', width: 1200, height: 627 },
  'ig-square': { label: 'Instagram square', width: 1080, height: 1080 },
  'ig-story': { label: 'Instagram story', width: 1080, height: 1920 },
  youtube: { label: 'YouTube thumbnail', width: 1280, height: 720 },
  custom: { label: 'Custom' },
};

export const PRESET_ORDER: PresetId[] = ['auto', 'x', 'linkedin', 'ig-square', 'ig-story', 'youtube', 'custom'];

/** Smallest and largest accepted custom canvas side, in px. */
export const CUSTOM_MIN = 64;
export const CUSTOM_MAX = 8192;
