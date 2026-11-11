/**
 * Entitlements (CONTRACTS section 5b) and the saved-look (user preset) rules that depend on them.
 *
 * Free: every feature, a small watermark, up to 3 saved looks. Pro: no watermark, unlimited looks,
 * custom brand mark. A key also carries an update window; a build released after it behaves as Free
 * and says so. All of this is pure so the limits can be tested without the UI.
 */
import { FREE_BATCH_LIMIT, FREE_PRESET_LIMIT, batchLimit as editorBatchLimit, presetLimit as editorPresetLimit } from '@polishot/editor';
import type { UserPreset } from '@polishot/editor/react';
import type { LicenseStatus } from '../../shared/ipc';

// The numbers live in the editor package (CONTRACTS 5b), so the desktop can never disagree with it.
export { FREE_BATCH_LIMIT, FREE_PRESET_LIMIT };

export type EntitlementReason = 'no-key' | 'invalid' | 'updates-expired';

export interface Entitlement {
  pro: boolean;
  reason?: EntitlementReason;
  /** ISO date (YYYY-MM-DD) up to which the key covers app updates. */
  updatesUntil?: string;
}

export const MAX_PRESETS = 100;
/** Settings.userPresets is capped at 256 KB on the Rust side; stay well below it. */
export const MAX_PRESETS_JSON_BYTES = 200 * 1024;

const REASONS: readonly EntitlementReason[] = ['no-key', 'invalid', 'updates-expired'];

/**
 * Entitlement for a licence status. Anything unknown fails closed: no status yet, or a status that
 * does not say Pro, is Free.
 */
export function entitlementFrom(status: LicenseStatus | null | undefined): Entitlement {
  if (!status || status.licensed !== true) {
    const reason = status?.reason && REASONS.includes(status.reason) ? status.reason : 'no-key';
    const ent: Entitlement = { pro: false, reason };
    if (status?.updatesUntil) ent.updatesUntil = status.updatesUntil;
    return ent;
  }
  const ent: Entitlement = { pro: true };
  if (status.updatesUntil) ent.updatesUntil = status.updatesUntil;
  return ent;
}

/** Maximum saved looks, or `Infinity` for Pro. */
export function presetLimit(ent: Entitlement): number {
  return editorPresetLimit(ent.pro);
}

/** Images per batch-beautify run, or `Infinity` for Pro. Hosts enforce it (CONTRACTS 5b). */
export function batchLimit(ent: Entitlement): number {
  return editorBatchLimit(ent.pro);
}

export function canSavePreset(count: number, ent: Entitlement): boolean {
  return count < presetLimit(ent);
}

export interface PresetQuota {
  used: number;
  /** Null when unlimited. */
  limit: number | null;
  atLimit: boolean;
}

export function presetQuota(count: number, ent: Entitlement): PresetQuota {
  const limit = ent.pro ? null : FREE_PRESET_LIMIT;
  return { used: count, limit, atLimit: limit !== null && count >= limit };
}

export const PRESET_LIMIT_MESSAGE = `Free includes ${FREE_PRESET_LIMIT} saved looks. Delete one, or get Pro for unlimited.`;

/** "14 November 2027" for an ISO date, or null when it is not a date. */
export function formatUpdatesUntil(iso: string | undefined, locale?: string): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** The message from section 5b, shown when this build is newer than the key's update window. */
export function updatesExpiredMessage(ent: Entitlement, locale?: string): string | null {
  if (ent.reason !== 'updates-expired') return null;
  const date = formatUpdatesUntil(ent.updatesUntil, locale);
  return date
    ? `Your license includes updates released until ${date}. This version came out later.`
    : 'Your license does not cover this version, which came out after your updates ended.';
}

/* ------------------------------------------------------------------ */
/* Saved looks stored in Settings.userPresets                           */
/* ------------------------------------------------------------------ */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parses the stored JSON array defensively: it is untrusted input (it may be hand-edited or come from
 * an older version). Invalid entries are dropped; the editor re-validates the look when it is applied.
 */
export function parseUserPresets(json: string | undefined | null): UserPreset[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: UserPreset[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PRESETS) break;
    if (!isRecord(item)) continue;
    const { id, name, settings } = item;
    if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) continue;
    if (typeof name !== 'string' || !name.trim()) continue;
    if (!isRecord(settings)) continue;
    if (typeof settings.padding !== 'number' || typeof settings.radius !== 'number' || typeof settings.shadow !== 'number') continue;
    if (typeof settings.frame !== 'string' || typeof settings.preset !== 'string' || !isRecord(settings.background)) continue;
    seen.add(id);
    out.push({ id, name: name.trim().slice(0, 40), settings: settings as unknown as UserPreset['settings'] });
  }
  return out;
}

export function serializeUserPresets(list: readonly UserPreset[]): string {
  return JSON.stringify(list);
}

export function newPresetId(now: number = Date.now(), random: () => number = Math.random): string {
  const rand = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `look-${now.toString(36)}${rand}`;
}

export type AddPresetResult = { ok: true; list: UserPreset[]; id: string } | { ok: false; error: string };

/** Adds a look, enforcing the Free limit. The caller persists `list` when `ok`. */
export function addPreset(
  list: readonly UserPreset[],
  preset: Omit<UserPreset, 'id'>,
  ent: Entitlement,
  now: number = Date.now(),
  random: () => number = Math.random,
): AddPresetResult {
  const name = preset.name.trim().slice(0, 40);
  if (!name) return { ok: false, error: 'Give this look a name first.' };
  if (!canSavePreset(list.length, ent)) return { ok: false, error: PRESET_LIMIT_MESSAGE };
  if (list.length >= MAX_PRESETS) return { ok: false, error: 'That is the most looks that can be saved.' };
  const id = newPresetId(now, random);
  const next = [...list, { id, name, settings: preset.settings }];
  if (serializeUserPresets(next).length > MAX_PRESETS_JSON_BYTES) {
    return { ok: false, error: 'Saved looks are using all of their space. Delete one first.' };
  }
  return { ok: true, list: next, id };
}

export function removePreset(list: readonly UserPreset[], id: string): UserPreset[] {
  return list.filter((p) => p.id !== id);
}
