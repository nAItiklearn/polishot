/**
 * The Pro "brand mark": your own text or logo instead of the default watermark (CONTRACTS 5b).
 *
 * The editor owns drawing and validation (`sanitizeBrandMark`, and it ignores the mark unless the editor is
 * licensed). The host owns where it is remembered. Settings has no field for it, so it lives in the
 * webview's local storage, which survives restarts. It is never part of the saved document.
 */
import { BRAND_MARK_MAX_TEXT, sanitizeBrandMark, type BrandMark } from '@polishot/editor';

export const BRAND_STORAGE_KEY = 'polishot.brandMark.v1';
export const MAX_BRAND_IMAGE_BYTES = 256 * 1024;
export const BRAND_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
export { BRAND_MARK_MAX_TEXT };

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The stored mark, re-validated (storage is untrusted input), or null. */
export function loadBrandMark(store: KeyValueStore | null | undefined): BrandMark | null {
  if (!store) return null;
  try {
    const raw = store.getItem(BRAND_STORAGE_KEY);
    return raw ? sanitizeBrandMark(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Stores a mark (null clears it). Returns false when it is invalid or cannot be stored. */
export function saveBrandMark(store: KeyValueStore | null | undefined, mark: BrandMark | null): boolean {
  if (!store) return false;
  try {
    if (mark === null) {
      store.removeItem(BRAND_STORAGE_KEY);
      return true;
    }
    const clean = sanitizeBrandMark(mark);
    if (!clean) return false;
    store.setItem(BRAND_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false; // quota exceeded or storage disabled
  }
}

/** A readable reason a chosen logo file cannot be used, or null if it is fine. */
export function checkBrandImage(file: { type: string; size: number }): string | null {
  if (!BRAND_IMAGE_TYPES.includes(file.type)) return 'Choose a PNG, JPEG or WebP image.';
  if (file.size > MAX_BRAND_IMAGE_BYTES) return `That image is larger than ${Math.round(MAX_BRAND_IMAGE_BYTES / 1024)} KB. Choose a smaller logo.`;
  if (file.size === 0) return 'That image is empty.';
  return null;
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unreadable file.')));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}
