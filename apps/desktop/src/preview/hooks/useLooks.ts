/**
 * Saved looks (user presets) as the editor's Inspector wants them, persisted in Settings.userPresets
 * and limited to 3 on Free (section 5b). The limit is enforced here as well as hidden in the UI.
 */
import type { UserPreset } from '@polishot/editor/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../context';
import { addPreset, parseUserPresets, presetQuota, removePreset, serializeUserPresets, type PresetQuota } from '../lib/entitlement';

export interface Looks {
  list: UserPreset[];
  quota: PresetQuota;
  loadPresets: () => UserPreset[];
  /**
   * Always provided: the Inspector draws the Free limit itself (the count, the note and the disabled field) and only
   * does so when it has a way to save. The limit is still enforced here, by `addPreset`, in case anything else calls it.
   */
  onSavePreset: (preset: Omit<UserPreset, 'id'>) => Promise<void>;
  onDeletePreset: (id: string) => Promise<void>;
}

export function useLooks(): Looks {
  const { settings, updateSettings, ent, notify } = useApp();
  const json = settings?.userPresets;
  const list = useMemo(() => parseUserPresets(json), [json]);
  const quota = useMemo(() => presetQuota(list.length, ent), [list.length, ent]);

  // The editor UI re-reads the list straight after a save, before React has re-rendered with the new
  // settings, so the freshest list is kept in a ref and updated synchronously.
  const ref = useRef(list);
  useEffect(() => {
    ref.current = list;
  }, [list]);

  const persist = useCallback(
    async (next: UserPreset[]): Promise<boolean> => {
      const err = await updateSettings({ userPresets: serializeUserPresets(next) });
      if (err) {
        notify({ message: err, tone: 'error' });
        return false;
      }
      ref.current = next;
      return true;
    },
    [updateSettings, notify],
  );

  const loadPresets = useCallback(() => ref.current, [json]);

  const onSavePreset = useCallback(
    async (preset: Omit<UserPreset, 'id'>) => {
      const result = addPreset(ref.current, preset, ent);
      if (!result.ok) {
        notify(result.error);
        return;
      }
      if (await persist(result.list)) notify(`Saved the look “${preset.name.trim().slice(0, 40)}”`);
    },
    [ent, notify, persist],
  );

  const onDeletePreset = useCallback(
    async (id: string) => {
      await persist(removePreset(ref.current, id));
    },
    [persist],
  );

  return { list, quota, loadPresets, onSavePreset, onDeletePreset };
}
