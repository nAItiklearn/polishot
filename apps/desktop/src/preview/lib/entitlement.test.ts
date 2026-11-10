import type { UserPreset } from '@polishot/editor/react';
import { describe, expect, it } from 'vitest';
import {
  FREE_PRESET_LIMIT,
  PRESET_LIMIT_MESSAGE,
  addPreset,
  canSavePreset,
  entitlementFrom,
  formatUpdatesUntil,
  parseUserPresets,
  presetLimit,
  presetQuota,
  removePreset,
  serializeUserPresets,
  updatesExpiredMessage,
  type Entitlement,
} from './entitlement';

const FREE: Entitlement = { pro: false, reason: 'no-key' };
const PRO: Entitlement = { pro: true };

const look = (id: string, name = id): UserPreset => ({
  id,
  name,
  settings: {
    padding: 0.08,
    background: { type: 'solid', color: '#ffffff' },
    radius: 12,
    shadow: 0.5,
    frame: 'none',
    preset: 'auto',
  },
});

describe('entitlementFrom (section 5b)', () => {
  it('is Free until the backend says otherwise', () => {
    expect(entitlementFrom(null)).toEqual({ pro: false, reason: 'no-key' });
    expect(entitlementFrom(undefined).pro).toBe(false);
    expect(entitlementFrom({ licensed: false }).reason).toBe('no-key');
  });

  it('is Pro only for licensed === true', () => {
    expect(entitlementFrom({ licensed: true, edition: 'personal', updatesUntil: '2027-11-09' })).toEqual({ pro: true, updatesUntil: '2027-11-09' });
    // Anything that is not the boolean true fails closed.
    expect(entitlementFrom({ licensed: 'yes' as unknown as boolean }).pro).toBe(false);
  });

  it('carries the reason and the update date when this build is newer than the key', () => {
    expect(entitlementFrom({ licensed: false, reason: 'updates-expired', updatesUntil: '2026-01-14' })).toEqual({
      pro: false,
      reason: 'updates-expired',
      updatesUntil: '2026-01-14',
    });
    expect(entitlementFrom({ licensed: false, reason: 'invalid' })).toEqual({ pro: false, reason: 'invalid' });
  });

  it('ignores an unknown reason', () => {
    expect(entitlementFrom({ licensed: false, reason: 'whatever' as never }).reason).toBe('no-key');
  });
});

describe('updates-expired message', () => {
  it('uses the wording from section 5b with the date', () => {
    const msg = updatesExpiredMessage({ pro: false, reason: 'updates-expired', updatesUntil: '2026-01-14' }, 'en-US');
    expect(msg).toBe('Your license includes updates released until January 14, 2026. This version came out later.');
  });

  it('is absent for other states', () => {
    expect(updatesExpiredMessage(FREE)).toBeNull();
    expect(updatesExpiredMessage(PRO)).toBeNull();
  });

  it('still says something sensible without a date', () => {
    expect(updatesExpiredMessage({ pro: false, reason: 'updates-expired' })).toMatch(/does not cover this version/);
  });

  it('formats ISO dates in UTC, and rejects garbage', () => {
    expect(formatUpdatesUntil('2027-11-09', 'en-US')).toBe('November 9, 2027');
    expect(formatUpdatesUntil('2027-11-09T23:59:59Z', 'en-US')).toBe('November 9, 2027');
    expect(formatUpdatesUntil('nope')).toBeNull();
    expect(formatUpdatesUntil(undefined)).toBeNull();
  });
});

describe('saved looks: the Free limit (3), Pro unlimited', () => {
  it('limits Free to 3 and leaves Pro unlimited', () => {
    expect(FREE_PRESET_LIMIT).toBe(3);
    expect(presetLimit(FREE)).toBe(3);
    expect(presetLimit(PRO)).toBe(Infinity);
    expect(canSavePreset(0, FREE)).toBe(true);
    expect(canSavePreset(2, FREE)).toBe(true);
    expect(canSavePreset(3, FREE)).toBe(false);
    expect(canSavePreset(300, FREE)).toBe(false);
    expect(canSavePreset(3, PRO)).toBe(true);
    expect(canSavePreset(300, PRO)).toBe(true);
  });

  it('reports the quota for the UI', () => {
    expect(presetQuota(2, FREE)).toEqual({ used: 2, limit: 3, atLimit: false });
    expect(presetQuota(3, FREE)).toEqual({ used: 3, limit: 3, atLimit: true });
    expect(presetQuota(9, PRO)).toEqual({ used: 9, limit: null, atLimit: false });
  });

  it('addPreset refuses the 4th look on Free, whatever the UI did', () => {
    let list: UserPreset[] = [];
    for (let i = 0; i < 3; i++) {
      const r = addPreset(list, { name: `Look ${i}`, settings: look('x').settings }, FREE, 1000 + i, () => 0.5);
      expect(r.ok).toBe(true);
      if (r.ok) list = r.list;
    }
    expect(list).toHaveLength(3);
    const blocked = addPreset(list, { name: 'One too many', settings: look('x').settings }, FREE);
    expect(blocked).toEqual({ ok: false, error: PRESET_LIMIT_MESSAGE });
    // The same list is fine for Pro.
    const allowed = addPreset(list, { name: 'One too many', settings: look('x').settings }, PRO);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.list).toHaveLength(4);
  });

  it('frees a slot when a look is deleted', () => {
    const list = [look('a'), look('b'), look('c')];
    expect(canSavePreset(list.length, FREE)).toBe(false);
    expect(canSavePreset(removePreset(list, 'b').length, FREE)).toBe(true);
  });

  it('needs a name, trims it and keeps it to 40 characters', () => {
    expect(addPreset([], { name: '   ', settings: look('x').settings }, FREE)).toEqual({ ok: false, error: 'Give this look a name first.' });
    const r = addPreset([], { name: `  ${'n'.repeat(60)}  `, settings: look('x').settings }, PRO);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.list[0]!.name).toHaveLength(40);
  });

  it('generates ids that the Rust settings validation accepts', () => {
    const r = addPreset([], { name: 'Mine', settings: look('x').settings }, FREE, Date.now());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('parseUserPresets (stored JSON is untrusted)', () => {
  it('round-trips a valid list', () => {
    const list = [look('look-1', 'Docs'), look('look-2', 'Social')];
    expect(parseUserPresets(serializeUserPresets(list))).toEqual(list);
  });

  it('returns an empty list for anything that is not a JSON array', () => {
    for (const bad of ['', 'null', '{}', '"x"', '12', 'not json', '[', undefined, null]) {
      expect(parseUserPresets(bad as string)).toEqual([]);
    }
  });

  it('drops malformed entries and duplicates but keeps the good ones', () => {
    const good = look('look-good', 'Good');
    const json = JSON.stringify([
      good,
      null,
      'text',
      { id: 'no-settings', name: 'x' },
      { id: 'bad id!', name: 'x', settings: good.settings },
      { id: '__proto__', name: 'x', settings: { ...good.settings, padding: 'wide' } },
      { id: 'look-good', name: 'Duplicate', settings: good.settings },
      { id: 'noname', name: '  ', settings: good.settings },
    ]);
    expect(parseUserPresets(json)).toEqual([good]);
  });

  it('caps the number of looks', () => {
    const many = Array.from({ length: 150 }, (_, i) => look(`look-${i}`));
    expect(parseUserPresets(JSON.stringify(many))).toHaveLength(100);
  });
});
