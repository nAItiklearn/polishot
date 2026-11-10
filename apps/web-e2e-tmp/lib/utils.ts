import { clsx, type ClassValue } from 'clsx';

/**
 * Joins class names. Deliberately clsx only (no tailwind-merge: it is 12 KB of client JS for a site this
 * small), so never pass two utilities that set the same property and expect the later one to win.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
