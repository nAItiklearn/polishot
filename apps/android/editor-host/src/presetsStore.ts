import type { UserPreset } from '@polishot/editor/react';
import { canSaveAnotherLook, MAX_SAVED_LOOKS } from './limits';

/*
 * Saved looks live in localStorage of the page's own origin (https://appassets.androidplatform.net), which only
 * this app's WebView can reach. The Inspector never touches storage itself; this is the host's persistence.
 */

const KEY = 'polishot-looks-v1';
const MAX_NAME = 40;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function read(): UserPreset[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is UserPreset => isRecord(p) && typeof p.id === 'string' && typeof p.name === 'string' && isRecord(p.settings))
      .slice(0, MAX_SAVED_LOOKS);
  } catch {
    return [];
  }
}

function write(list: UserPreset[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_SAVED_LOOKS)));
    return true;
  } catch {
    return false; // storage full or disabled
  }
}

export type SaveLookResult = 'saved' | 'limit' | 'failed';

export const looks = {
  load(): UserPreset[] {
    return read();
  },

  save(preset: Omit<UserPreset, 'id'>, pro: boolean): SaveLookResult {
    const list = read();
    if (!canSaveAnotherLook(list.length, pro)) return 'limit';
    const id = `look-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    list.push({ ...preset, id, name: preset.name.slice(0, MAX_NAME) });
    return write(list) ? 'saved' : 'failed';
  },

  remove(id: string): void {
    write(read().filter((p) => p.id !== id));
  },
};
