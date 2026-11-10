import manifest from '../public/shots/manifest.json';

/**
 * Product shots are real captures of the app, produced by tools/shots and described in
 * public/shots/manifest.json (the single source of truth for size, alt text and what must be on screen).
 */
export type ShotName = keyof typeof manifest.shots;

export interface Shot {
  name: ShotName;
  width: number;
  height: number;
  alt: string;
  show: string;
  src: string;
}

export function getShot(name: ShotName): Shot {
  const entry = manifest.shots[name];
  return { name, ...entry, src: `/shots/${name}.${manifest.format}` };
}

export const SHOT_NAMES = Object.keys(manifest.shots) as ShotName[];
