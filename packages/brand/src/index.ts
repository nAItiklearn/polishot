/**
 * Single source of truth for the product name and design tokens.
 * Renaming the product: change APP_NAME / APP_SLUG here, then run
 * `pnpm --filter @polishot/brand test` — the brand-sync test lists every
 * native file (Tauri config, Android Brand.kt) that must be updated to match.
 */
export const APP_NAME = 'Polishot';
export const APP_SLUG = 'polishot';
export const APP_ID = 'app.polishot';
export const WATERMARK_TEXT = `Made with ${APP_NAME}`;
export const SITE_URL = 'https://polishot.app';

export type Theme = 'light' | 'dark';

/** Palette: warm neutrals plus one accent (Persimmon). Values mirror tokens.css. */
export const palette = {
  light: {
    bg: '#FAFAF9',
    surface: '#FFFFFF',
    surface2: '#F3F3F1',
    border: '#E6E5E1',
    text: '#161615',
    text2: '#57564F',
    text3: '#6B6A63',
    accent: '#C8471D',
    accentText: '#B03C15',
    accentFg: '#FFFFFF',
    focus: '#C8471D',
  },
  dark: {
    bg: '#0C0C0B',
    surface: '#151514',
    surface2: '#1D1D1B',
    border: '#2B2B28',
    text: '#EDECE8',
    text2: '#A6A59F',
    text3: '#8C8B85',
    accent: '#EE7444',
    accentText: '#F28D63',
    accentFg: '#170A04',
    focus: '#F28D63',
  },
} as const;

export const motion = {
  fast: 150,
  base: 180,
  slow: 200,
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

export const radius = { sm: 6, md: 10, lg: 14 } as const;
export const space = (n: number) => n * 8;
