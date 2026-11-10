/**
 * Offline Ed25519 licence keys (CONTRACTS section 3).
 *
 * Payload (30 bytes): version(1) | edition(1) | issuedDays u32 BE (4) | keyId (8) | licenseeHash (16).
 * Key text: `PSHOT-` + Crockford base32 of payload || signature(64), in groups of 6 joined by `-`.
 *
 * Parsing rules (the Rust and Kotlin implementations follow the same order):
 *  1. input longer than 300 characters                       -> `length`
 *  2. trim ASCII whitespace; drop a leading `PSHOT-` (any case); ignore ASCII whitespace and `-`
 *  3. any other character that is not Crockford base32       -> `format`
 *  4. decoded byte count is not 94                           -> `length`
 *  5. Ed25519 signature (strict) over the payload fails      -> `signature`
 *  6. version byte is not 1, or edition byte is not 1 or 2   -> `version`
 */
import * as ed from '@noble/ed25519';
import { decodeBase32, encodeBase32 } from './base32';
import { PUBLIC_KEY_HEX } from './publicKey';

export { PUBLIC_KEY_HEX };

export type Edition = 'personal' | 'team';

export interface LicenseInfo {
  version: 1;
  edition: Edition;
  issuedAt: Date;
  /**
   * The exact unsigned 32-bit issue day (days since the Unix epoch). `issuedAt` is a JS Date and is clamped
   * for absurd values (a vector uses 4294967295); the update-window maths uses this field.
   */
  issuedDays: number;
  /** 16 lowercase hex chars (8 bytes). */
  keyId: string;
  /** 32 lowercase hex chars (first 16 bytes of SHA-256 of the normalised email). */
  licenseeHash: string;
}

export type VerifyResult =
  | { valid: true; info: LicenseInfo }
  | { valid: false; reason: 'format' | 'length' | 'version' | 'signature' };

const PAYLOAD_LEN = 30;
const SIGNATURE_LEN = 64;
const MAX_INPUT_LEN = 300;
const PREFIX = 'PSHOT-';
const GROUP = 6;
const DAY_MS = 86_400_000;
/** Largest day count a JS Date can hold; u32 values above it are clamped (never issued in practice). */
const MAX_DATE_DAYS = 100_000_000;

type Parsed =
  | { ok: true; payload: Uint8Array; signature: Uint8Array }
  | { ok: false; reason: 'format' | 'length' };

function isAsciiSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

/** ASCII-only, case-insensitive check for `PSHOT-`. */
function hasPrefix(text: string): boolean {
  if (text.length < PREFIX.length) return false;
  for (let i = 0; i < PREFIX.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0x61 && code <= 0x7a) code -= 0x20;
    if (code !== PREFIX.charCodeAt(i)) return false;
  }
  return true;
}

function parseKey(key: unknown): Parsed {
  if (typeof key !== 'string') return { ok: false, reason: 'format' };
  if (key.length > MAX_INPUT_LEN) return { ok: false, reason: 'length' };

  let start = 0;
  let end = key.length;
  while (start < end && isAsciiSpace(key.charCodeAt(start))) start++;
  while (end > start && isAsciiSpace(key.charCodeAt(end - 1))) end--;
  let text = key.slice(start, end);
  if (hasPrefix(text)) text = text.slice(PREFIX.length);

  const bytes = decodeBase32(text);
  if (bytes === null) return { ok: false, reason: 'format' };
  if (bytes.length !== PAYLOAD_LEN + SIGNATURE_LEN) return { ok: false, reason: 'length' };
  return {
    ok: true,
    payload: bytes.slice(0, PAYLOAD_LEN),
    signature: bytes.slice(PAYLOAD_LEN),
  };
}

/** Encodes `payload` (30 bytes) and `signature` (64 bytes) as `PSHOT-XXXXXX-XXXXXX-...`. */
export function encodeKey(payload: Uint8Array, signature: Uint8Array): string {
  if (payload.length !== PAYLOAD_LEN) throw new RangeError(`payload must be ${PAYLOAD_LEN} bytes`);
  if (signature.length !== SIGNATURE_LEN) {
    throw new RangeError(`signature must be ${SIGNATURE_LEN} bytes`);
  }
  const body = new Uint8Array(PAYLOAD_LEN + SIGNATURE_LEN);
  body.set(payload, 0);
  body.set(signature, PAYLOAD_LEN);
  const text = encodeBase32(body);
  const groups: string[] = [];
  for (let i = 0; i < text.length; i += GROUP) groups.push(text.slice(i, i + GROUP));
  return PREFIX + groups.join('-');
}

/** Lenient decode; `null` for any malformed input (bad characters or wrong byte length). */
export function decodeKey(key: string): { payload: Uint8Array; signature: Uint8Array } | null {
  const parsed = parseKey(key);
  return parsed.ok ? { payload: parsed.payload, signature: parsed.signature } : null;
}

/** First 16 bytes of SHA-256(lowercase(trim(email))) as 32 lowercase hex chars. */
export async function licenseeHash(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return ed.etc.bytesToHex(new Uint8Array(digest, 0, 16));
}

/** Never throws: every failure is reported through `reason`. */
export async function verifyLicense(
  key: string,
  publicKeyHex: string = PUBLIC_KEY_HEX,
): Promise<VerifyResult> {
  try {
    const parsed = parseKey(key);
    if (!parsed.ok) return { valid: false, reason: parsed.reason };
    const { payload, signature } = parsed;

    const publicKey = ed.etc.hexToBytes(publicKeyHex);
    const ok = await ed.verifyAsync(signature, payload, publicKey, { zip215: false });
    if (!ok) return { valid: false, reason: 'signature' };

    const version = payload[0];
    const editionByte = payload[1];
    if (version !== 1 || (editionByte !== 1 && editionByte !== 2)) {
      return { valid: false, reason: 'version' };
    }
    const issuedDays = new DataView(payload.buffer, payload.byteOffset, PAYLOAD_LEN).getUint32(2);
    return {
      valid: true,
      info: {
        version: 1,
        edition: editionByte === 1 ? 'personal' : 'team',
        issuedAt: new Date(Math.min(issuedDays, MAX_DATE_DAYS) * DAY_MS),
        issuedDays,
        keyId: ed.etc.bytesToHex(payload.subarray(6, 14)),
        licenseeHash: ed.etc.bytesToHex(payload.subarray(14, 30)),
      },
    };
  } catch {
    return { valid: false, reason: 'signature' };
  }
}

/* ------------------------------------------------------------------ */
/* Update window and entitlement (CONTRACTS section 5b)                  */
/* ------------------------------------------------------------------ */

/** A key covers every app build dated no later than `issuedDays + UPDATE_WINDOW_DAYS`. */
export const UPDATE_WINDOW_DAYS = 365;
const U32_MAX = 0xffff_ffff;

/** Why Pro is off. `updates-expired` means the key is genuine but this build is newer than its window. */
export type EntitlementReason = 'no-key' | 'invalid' | 'updates-expired';

/** What the app is allowed to do. `pro` is the editor's `licensed` flag. */
export interface Entitlement {
  pro: boolean;
  reason?: EntitlementReason;
  /** ISO date (YYYY-MM-DD) of the last covered build day; present when a genuine key was checked. */
  updatesUntil?: string;
}

/** Only `issuedDays` is read when present; `issuedAt` is the fallback for hand-made objects. */
type HasIssueDay = Pick<LicenseInfo, 'issuedAt'> & Partial<Pick<LicenseInfo, 'issuedDays'>>;

function issueDay(info: HasIssueDay): number {
  const days = info.issuedDays;
  if (typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= U32_MAX)
    return days;
  return Math.floor(info.issuedAt.getTime() / DAY_MS);
}

/**
 * The last build day (days since the Unix epoch) the key covers: `issuedDays + 365`, saturating at the
 * unsigned 32-bit maximum exactly like the Rust crate (`u32::saturating_add`) and the Kotlin port.
 */
export function updatesUntilDays(info: HasIssueDay): number {
  return Math.min(issueDay(info) + UPDATE_WINDOW_DAYS, U32_MAX);
}

/** `updatesUntilDays` as a Date (midnight UTC); clamped to the largest date a JS Date can hold. */
export function updatesUntilDate(info: HasIssueDay): Date {
  return new Date(Math.min(updatesUntilDays(info), MAX_DATE_DAYS) * DAY_MS);
}

/**
 * True when an app build made on `buildDays` (days since the Unix epoch, UTC) is covered by the key.
 * The boundary day is included. Fails closed: anything that is not an integer in 0..4294967295 is not covered.
 */
export function coversBuild(info: HasIssueDay, buildDays: number): boolean {
  if (!Number.isInteger(buildDays) || buildDays < 0 || buildDays > U32_MAX) return false;
  return buildDays <= updatesUntilDays(info);
}

/**
 * Days since the Unix epoch (UTC) of a build date. Apps embed this as `BUILD_DAYS` at build time; see README.
 * Throws a RangeError for an invalid date so a broken build script fails loudly instead of embedding
 * a value that would cover every key.
 */
export function buildDaysFromDate(d: Date): number {
  const days = Math.floor(d.getTime() / DAY_MS);
  if (!Number.isFinite(days) || days < 0 || days > U32_MAX) {
    throw new RangeError('buildDaysFromDate: the date is invalid or before 1970');
  }
  return days;
}

/** `YYYY-MM-DD` for a count of days since 1970-01-01 (proleptic Gregorian, UTC); works for any u32. */
export function daysToIso(days: number): string {
  if (!Number.isInteger(days) || days < 0 || days > U32_MAX) {
    throw new RangeError('daysToIso: days must be an integer in 0..4294967295');
  }
  // Howard Hinnant's civil_from_days (the Rust desktop code uses the same algorithm).
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${two(m)}-${two(d)}`;
}

/**
 * Turns a verification result into what the app may do. `null`/`undefined` means nothing is activated.
 * Fails closed: a missing, invalid or malformed result is never Pro, and a genuine key only unlocks builds
 * inside its update window (an `updates-expired` build behaves as Free but reports the date).
 */
export function entitlement(
  result: VerifyResult | null | undefined,
  buildDays: number,
): Entitlement {
  if (result === null || result === undefined) return { pro: false, reason: 'no-key' };
  if (result.valid !== true || typeof result.info !== 'object' || result.info === null) {
    return { pro: false, reason: 'invalid' };
  }
  const until = updatesUntilDays(result.info);
  if (!Number.isInteger(until)) return { pro: false, reason: 'invalid' };
  const updatesUntil = daysToIso(until);
  if (coversBuild(result.info, buildDays)) return { pro: true, updatesUntil };
  return { pro: false, reason: 'updates-expired', updatesUntil };
}
