import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  UPDATE_WINDOW_DAYS,
  buildDaysFromDate,
  coversBuild,
  daysToIso,
  entitlement,
  updatesUntilDate,
  updatesUntilDays,
  verifyLicense,
  type LicenseInfo,
  type VerifyResult,
} from '../src/index';

interface EntitlementCase {
  name: string;
  key: string;
  buildDays: number;
  pro: boolean;
  reason?: 'no-key' | 'invalid' | 'updates-expired';
  updatesUntilDays?: number;
}
interface Vectors {
  publicKeyHex: string;
  cases: { name: string; key: string; valid: boolean; issuedDays?: number }[];
  entitlementCases: EntitlementCase[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../test-vectors.json', import.meta.url), 'utf8'),
) as Vectors;

const U32_MAX = 4_294_967_295;
const DAY_MS = 86_400_000;

function info(issuedDays: number): LicenseInfo {
  return {
    version: 1,
    edition: 'personal',
    issuedAt: new Date(Math.min(issuedDays, 100_000_000) * DAY_MS),
    issuedDays,
    keyId: '0011223344556677',
    licenseeHash: '00112233445566778899aabbccddeeff',
  };
}
const valid = (issuedDays: number): VerifyResult => ({ valid: true, info: info(issuedDays) });

describe('shared entitlement vectors', () => {
  it('cover the window, its inclusive boundary, one day after, an invalid key and no key', () => {
    const cases = vectors.entitlementCases;
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.some((c) => c.pro && c.updatesUntilDays !== undefined)).toBe(true);
    expect(
      cases.some(
        (c) => c.pro && c.updatesUntilDays !== undefined && c.buildDays === c.updatesUntilDays,
      ),
    ).toBe(true);
    expect(
      cases.some(
        (c) =>
          c.reason === 'updates-expired' &&
          c.updatesUntilDays !== undefined &&
          c.buildDays === c.updatesUntilDays + 1,
      ),
    ).toBe(true);
    expect(cases.some((c) => c.reason === 'invalid')).toBe(true);
    expect(cases.some((c) => c.reason === 'no-key')).toBe(true);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  for (const c of vectors.entitlementCases) {
    it(`vector: ${c.name}`, async () => {
      const blank = c.key.trim() === '';
      const result = blank ? null : await verifyLicense(c.key, vectors.publicKeyHex);
      const got = entitlement(result, c.buildDays);
      expect(got.pro).toBe(c.pro);
      expect(got.reason).toBe(c.reason);
      if (c.updatesUntilDays === undefined) {
        expect(got.updatesUntil).toBeUndefined();
        return;
      }
      expect(got.updatesUntil).toBe(daysToIso(c.updatesUntilDays));
      expect(result?.valid).toBe(true);
      if (result?.valid) {
        expect(updatesUntilDays(result.info)).toBe(c.updatesUntilDays);
        expect(coversBuild(result.info, c.buildDays)).toBe(c.pro);
      }
    });
  }

  it('the personal key issued 2026-01-15 covers builds up to 2027-01-15', async () => {
    const personal = vectors.cases.find((c) => c.name === 'valid-personal')!;
    const result = await verifyLicense(personal.key, vectors.publicKeyHex);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.info.issuedDays).toBe(personal.issuedDays);
    expect(updatesUntilDate(result.info).toISOString().slice(0, 10)).toBe('2027-01-15');
    const last = buildDaysFromDate(new Date('2027-01-15T23:59:59Z'));
    expect(entitlement(result, last)).toEqual({ pro: true, updatesUntil: '2027-01-15' });
    const next = buildDaysFromDate(new Date('2027-01-16T00:00:00Z'));
    expect(entitlement(result, next)).toEqual({
      pro: false,
      reason: 'updates-expired',
      updatesUntil: '2027-01-15',
    });
  });
});

describe('update window arithmetic', () => {
  it('is issuedDays + 365 and the boundary day is included', () => {
    expect(UPDATE_WINDOW_DAYS).toBe(365);
    const i = info(20_000);
    expect(updatesUntilDays(i)).toBe(20_365);
    expect(coversBuild(i, 20_364)).toBe(true);
    expect(coversBuild(i, 20_365)).toBe(true);
    expect(coversBuild(i, 20_366)).toBe(false);
    expect(coversBuild(i, 0)).toBe(true);
    expect(coversBuild(i, 20_000)).toBe(true);
  });

  it('saturates at the unsigned 32-bit maximum instead of overflowing', () => {
    for (const issued of [U32_MAX, U32_MAX - 1, U32_MAX - 364, U32_MAX - 365]) {
      const i = info(issued);
      expect(updatesUntilDays(i)).toBe(Math.min(issued + 365, U32_MAX));
      expect(coversBuild(i, 20_000)).toBe(true);
    }
    expect(updatesUntilDays(info(U32_MAX))).toBe(U32_MAX);
    expect(coversBuild(info(U32_MAX), U32_MAX)).toBe(true);
    // The wrapped-around value would be 364; a wrapping implementation would call a normal build expired.
    expect(updatesUntilDays(info(U32_MAX))).not.toBe(364);
    expect(updatesUntilDays(info(U32_MAX - 365))).toBe(U32_MAX);
    expect(coversBuild(info(U32_MAX - 366), U32_MAX)).toBe(false);
  });

  it('updatesUntilDate is midnight UTC of the last covered day, clamped for huge values', () => {
    expect(updatesUntilDate(info(20_468)).toISOString()).toBe('2027-01-15T00:00:00.000Z');
    const far = updatesUntilDate(info(U32_MAX));
    expect(Number.isFinite(far.getTime())).toBe(true);
    expect(far.getTime()).toBe(100_000_000 * DAY_MS);
  });

  it('falls back to issuedAt for hand-made objects without issuedDays', () => {
    const issuedAt = new Date(20_468 * DAY_MS);
    expect(updatesUntilDays({ issuedAt })).toBe(20_833);
    expect(coversBuild({ issuedAt }, 20_833)).toBe(true);
    expect(coversBuild({ issuedAt }, 20_834)).toBe(false);
  });

  it('coversBuild fails closed for build values that are not a plausible day count', () => {
    const i = info(20_000);
    for (const bad of [Number.NaN, Infinity, -Infinity, -1, 0.5, 20_000.5, U32_MAX + 1, 1e20]) {
      expect(coversBuild(i, bad), String(bad)).toBe(false);
    }
    // @ts-expect-error runtime check: a string is not a number
    expect(coversBuild(i, '20000')).toBe(false);
    // @ts-expect-error runtime check: undefined is not a number
    expect(coversBuild(i, undefined)).toBe(false);
    // Even a key that covers everything does not cover a nonsensical build.
    expect(coversBuild(info(U32_MAX), Number.NaN)).toBe(false);
    expect(coversBuild(info(U32_MAX), U32_MAX + 1)).toBe(false);
  });
});

describe('entitlement()', () => {
  it('no key and malformed results are never Pro', () => {
    expect(entitlement(null, 20_000)).toEqual({ pro: false, reason: 'no-key' });
    expect(entitlement(undefined, 20_000)).toEqual({ pro: false, reason: 'no-key' });
    for (const reason of ['format', 'length', 'version', 'signature'] as const) {
      expect(entitlement({ valid: false, reason }, 20_000)).toEqual({
        pro: false,
        reason: 'invalid',
      });
    }
    // Malformed objects that merely look truthy must not unlock Pro.
    const bad = [
      {},
      { valid: 'yes' },
      { valid: true },
      { valid: true, info: null },
      { valid: true, info: 'x' },
      { valid: true, info: { issuedAt: new Date(Number.NaN) } },
    ] as unknown as VerifyResult[];
    for (const r of bad)
      expect(entitlement(r, 20_000), JSON.stringify(r)).toEqual({ pro: false, reason: 'invalid' });
  });

  it('a genuine key inside its window is Pro and reports the end date', () => {
    expect(entitlement(valid(20_468), 20_468 + 365)).toEqual({
      pro: true,
      updatesUntil: '2027-01-15',
    });
  });

  it('a genuine key outside its window is Free and still reports the date', () => {
    expect(entitlement(valid(20_468), 20_468 + 366)).toEqual({
      pro: false,
      reason: 'updates-expired',
      updatesUntil: '2027-01-15',
    });
  });

  it('an implausible build value is treated as outside the window', () => {
    expect(entitlement(valid(20_468), Number.NaN).pro).toBe(false);
    expect(entitlement(valid(20_468), -5).pro).toBe(false);
    expect(entitlement(valid(20_468), Number.NaN).reason).toBe('updates-expired');
  });

  it('never throws for the extreme issue days', () => {
    expect(entitlement(valid(U32_MAX), 20_000).pro).toBe(true);
    expect(entitlement(valid(0), 365).pro).toBe(true);
    expect(entitlement(valid(0), 366).pro).toBe(false);
  });
});

describe('buildDaysFromDate()', () => {
  it('is days since the Unix epoch in UTC', () => {
    expect(buildDaysFromDate(new Date('2200-01-01T00:00:00Z'))).toBe(84_006);
    expect(buildDaysFromDate(new Date(0))).toBe(0);
    expect(buildDaysFromDate(new Date('1970-01-02T00:00:00Z'))).toBe(1);
    expect(buildDaysFromDate(new Date('2026-01-15T00:00:00Z'))).toBe(20_468);
    expect(buildDaysFromDate(new Date('2026-01-15T23:59:59.999Z'))).toBe(20_468);
    expect(buildDaysFromDate(new Date('2026-01-14T23:59:59.999Z'))).toBe(20_467);
  });

  it('throws for dates that would embed a bogus build day', () => {
    expect(() => buildDaysFromDate(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => buildDaysFromDate(new Date('1969-12-31T23:59:59Z'))).toThrow(RangeError);
  });
});

describe('daysToIso()', () => {
  it('matches Date for every day over several decades', () => {
    for (let d = 0; d < 365 * 80; d += 1) {
      expect(daysToIso(d)).toBe(new Date(d * DAY_MS).toISOString().slice(0, 10));
    }
  });

  it('handles leap days, century rules and far-future values', () => {
    expect(daysToIso(0)).toBe('1970-01-01');
    expect(daysToIso(11_016)).toBe('2000-02-29');
    expect(daysToIso(20_833)).toBe('2027-01-15');
    expect(daysToIso(2_932_896)).toBe('9999-12-31');
    expect(daysToIso(U32_MAX)).toBe('11761191-01-20');
  });

  it('rejects anything that is not an unsigned 32-bit integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity, U32_MAX + 1]) {
      expect(() => daysToIso(bad), String(bad)).toThrow(RangeError);
    }
  });
});
