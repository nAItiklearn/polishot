import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** tools/shots */
export const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Repository root. */
export const REPO_ROOT = resolve(TOOL_DIR, '..', '..');

export const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');
export const EDITOR_DIR = join(REPO_ROOT, 'packages', 'editor');

/** Where the website reads its product shots from. */
export const SHOTS_PUBLIC_DIR = join(REPO_ROOT, 'apps', 'web', 'public', 'shots');
export const MANIFEST_PATH = join(SHOTS_PUBLIC_DIR, 'manifest.json');

/** Scratch output: full-resolution PNGs of every shot, for review. Git-ignored. */
export const OUT_DIR = join(TOOL_DIR, 'out');
