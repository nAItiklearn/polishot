/**
 * Saved looks ("presets") for the web editor. They are kept in this browser's localStorage and nowhere else:
 * the editor package leaves persistence to the host, and this host never sends anything over the network.
 *
 * Stored data is untrusted (another tab, an extension or the user can edit it), so every look is rebuilt
 * from known fields and run through `validateDoc` on the way in, exactly like a document from history.
 * The Free limit (CONTRACTS 5b: 3 saved presets) is enforced here too, not only in the Inspector, so the
 * rule holds even if the UI is bypassed. The website has no licence activation, so every visitor is Free.
 */
import { createDoc, FREE_PRESET_LIMIT, presetLimit, validateDoc } from '@polishot/editor';
import type { LookSettings, UserPreset } from '@polishot/editor/react';

export const LOOKS_KEY = 'polishot.looks.v1';

/** Never read more than this many entries or characters back, whatever is in storage. */
const MAX_READ = 24;
const MAX_STORE_CHARS = 2_000_000;
const MAX_NAME = 40;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Control characters, zero-width characters and bidi overrides: none belong in a label.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

export type LooksStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type SaveResult = { ok: true; look: UserPreset } | { ok: false; reason: 'limit' | 'storage' | 'invalid' };

export const SAVE_ERROR: Record<Exclude<SaveResult, { ok: true }>['reason'], string> = {
  limit: `Free keeps ${FREE_PRESET_LIMIT} saved looks. Delete one to save another.`,
  storage: 'This look could not be saved. Your browser blocked storage or it is full; try without a background image.',
  invalid: 'This look could not be saved.',
};

/** localStorage, or null when the browser refuses access (private modes and some policies throw). */
export function browserStorage(): LooksStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Collapses whitespace, strips control characters and cuts the name to its limit. */
export function cleanName(name: string): string {
  return name
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/** Rebuilds look settings from known fields and validates them as a document. Null when anything is off. */
export function sanitizeSettings(input: unknown): LookSettings | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const s = input as Record<string, unknown>;
  const doc = validateDoc({
    ...createDoc({ id: 'look', width: 1, height: 1 }),
    padding: s.padding,
    background: s.background,
    radius: s.radius,
    shadow: s.shadow,
    frame: s.frame,
    preset: s.preset,
    ...(s.custom === undefined ? {} : { custom: s.custom }),
  });
  if (!doc) return null;
  return {
    padding: doc.padding,
    background: doc.background,
    radius: doc.radius,
    shadow: doc.shadow,
    frame: doc.frame,
    preset: doc.preset,
    ...(doc.custom ? { custom: doc.custom } : {}),
  };
}

/** All saved looks, in the order they were saved. Anything unreadable is skipped, never thrown. */
export function readLooks(storage: LooksStorage | null): UserPreset[] {
  if (!storage) return [];
  let parsed: unknown;
  try {
    const raw = storage.getItem(LOOKS_KEY);
    if (!raw || raw.length > MAX_STORE_CHARS) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: UserPreset[] = [];
  const seen = new Set<string>();
  for (const item of parsed.slice(0, MAX_READ)) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, name, settings } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || seen.has(id) || typeof name !== 'string') continue;
    const label = cleanName(name);
    const clean = sanitizeSettings(settings);
    if (!label || !clean) continue;
    seen.add(id);
    out.push({ id, name: label, settings: clean });
  }
  return out;
}

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `look-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function write(storage: LooksStorage, looks: UserPreset[]): boolean {
  try {
    const json = JSON.stringify(looks);
    if (json.length > MAX_STORE_CHARS) return false;
    storage.setItem(LOOKS_KEY, json);
    return true;
  } catch {
    return false;
  }
}

/** Saves a look. Refuses past the Free limit, and when storage is blocked or full. */
export function addLook(storage: LooksStorage | null, preset: Omit<UserPreset, 'id'>, makeId: () => string = newId): SaveResult {
  if (!storage) return { ok: false, reason: 'storage' };
  const name = cleanName(preset.name);
  const settings = sanitizeSettings(preset.settings);
  if (!name || !settings) return { ok: false, reason: 'invalid' };
  const existing = readLooks(storage);
  // The website has no licence activation, so the Free limit is the only limit.
  if (existing.length >= presetLimit(false)) return { ok: false, reason: 'limit' };
  const id = makeId();
  if (!ID_PATTERN.test(id)) return { ok: false, reason: 'invalid' };
  const look: UserPreset = { id, name, settings };
  return write(storage, [...existing, look]) ? { ok: true, look } : { ok: false, reason: 'storage' };
}

/** Deletes a look. Unknown ids are ignored. */
export function removeLook(storage: LooksStorage | null, id: string): boolean {
  if (!storage) return false;
  const existing = readLooks(storage);
  const next = existing.filter((l) => l.id !== id);
  return next.length === existing.length ? true : write(storage, next);
}
