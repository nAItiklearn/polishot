#!/usr/bin/env node
/**
 * Polishot licence key tool. Offline, no network.
 *
 *   init [--force]                          create the production keypair
 *   issue --email <e> --edition personal|team [--date YYYY-MM-DD]
 *   verify [--test] <key>                   decode and verify a key
 *   vectors                                 regenerate packages/license/test-vectors.json (TEST key only)
 *
 * The production private key lives only in tools/license-keygen/keys/ (gitignored). It is never
 * printed, never written anywhere else and never imported by app code.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as ed from '@noble/ed25519';

// @polishot/license is consumed as TypeScript source with extensionless relative imports.
// Node strips the types natively but cannot resolve `./base32`, so retry with `.ts`.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && error?.code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
const {
  PUBLIC_KEY_HEX,
  daysToIso,
  decodeKey,
  encodeKey,
  entitlement,
  licenseeHash,
  verifyLicense,
} = await import('@polishot/license');

const here = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(here, 'keys');
const PROD_PRIVATE = join(KEYS_DIR, 'prod.private.key');
const LICENSE_DIR = resolve(here, '..', '..', 'packages', 'license');
const PUBLIC_KEY_FILE = join(LICENSE_DIR, 'public-key.hex');
const PUBLIC_KEY_TS = join(LICENSE_DIR, 'src', 'publicKey.ts');
const TEST_KEYPAIR = join(LICENSE_DIR, 'test-keypair.json');
const TEST_VECTORS = join(LICENSE_DIR, 'test-vectors.json');

const EDITIONS = { personal: 1, team: 2 };
const DAY_MS = 86_400_000;
const HEX64 = /^[0-9a-f]{64}$/;

class UsageError extends Error {}

const usage = `Usage:
  license-keygen init [--force]
  license-keygen issue --email <email> --edition personal|team [--date YYYY-MM-DD]
  license-keygen verify [--test] <key>
  license-keygen vectors`;

// ---------------------------------------------------------------- helpers

const hex = (bytes) => ed.etc.bytesToHex(bytes);

function parseDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const ms = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== text) {
    throw new UsageError(`Invalid --date "${text}" (expected a real date as YYYY-MM-DD).`);
  }
  const days = ms / DAY_MS;
  if (days < 0 || days > 0xffffffff) throw new UsageError(`--date "${text}" is out of range.`);
  return days;
}

function todayDays() {
  return Math.floor(Date.now() / DAY_MS);
}

/** payload = version | edition | issuedDays u32 BE | keyId (8) | licenseeHash (16) */
function buildPayload({ version = 1, edition, days, keyId, licensee }) {
  const payload = new Uint8Array(30);
  payload[0] = version;
  payload[1] = edition;
  new DataView(payload.buffer).setUint32(2, days);
  payload.set(keyId, 6);
  payload.set(licensee, 14);
  return payload;
}

async function mint(secretKey, fields) {
  const payload = buildPayload(fields);
  return encodeKey(payload, await ed.signAsync(payload, secretKey));
}

async function licenseeBytes(email) {
  return ed.etc.hexToBytes(await licenseeHash(email));
}

function readHexFile(path, what) {
  const text = readFileSync(path, 'utf8').trim();
  if (!HEX64.test(text)) throw new UsageError(`${what} (${path}) is not 64 hex characters.`);
  return text;
}

/** Restrict the private key file to the current user where the platform allows it. */
function lockDown(path) {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls', [path, '/grant:r', `${userInfo().username}:F`, '/inheritance:r'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      console.error(`warning: could not restrict permissions on ${path}; do it manually.`);
    }
  }
}

// --------------------------------------------------------------- commands

async function init({ force }) {
  const havePublic =
    existsSync(PUBLIC_KEY_FILE) && HEX64.test(readFileSync(PUBLIC_KEY_FILE, 'utf8').trim());
  if ((existsSync(PROD_PRIVATE) || havePublic) && !force) {
    throw new UsageError(
      'A production key already exists. Re-running init would invalidate every issued licence.\n' +
        'Pass --force only if you really mean to replace it (the old private key is kept as a .bak).',
    );
  }
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(PROD_PRIVATE)) {
    renameSync(PROD_PRIVATE, `${PROD_PRIVATE}.${Math.floor(Date.now() / 1000)}.bak`);
  }

  const secretKey = ed.utils.randomSecretKey();
  const publicHex = hex(await ed.getPublicKeyAsync(secretKey));

  writeFileSync(PROD_PRIVATE, `${hex(secretKey)}\n`, { mode: 0o600, flag: 'wx' });
  lockDown(PROD_PRIVATE);
  writeFileSync(PUBLIC_KEY_FILE, `${publicHex}\n`);
  writeFileSync(
    PUBLIC_KEY_TS,
    '// Generated by `license-keygen init`. Must equal packages/license/public-key.hex (a test checks this).\n' +
      `export const PUBLIC_KEY_HEX = '${publicHex}';\n`,
  );

  console.log(`Public key:  ${publicHex}`);
  console.log(`Written to:  ${PUBLIC_KEY_FILE}`);
  console.log(`             ${PUBLIC_KEY_TS}`);
  console.log(
    `Private key: ${PROD_PRIVATE} (gitignored; back it up somewhere safe, it cannot be recovered)`,
  );
}

async function issue({ email, edition, date }) {
  if (!email || !email.includes('@')) throw new UsageError('--email <address> is required.');
  const editionByte = EDITIONS[edition ?? ''];
  if (editionByte === undefined) throw new UsageError('--edition must be "personal" or "team".');
  const days = date === undefined ? todayDays() : parseDate(date);

  if (!existsSync(PROD_PRIVATE)) {
    throw new UsageError(`No production key at ${PROD_PRIVATE}. Run "init" first.`);
  }
  const secretKey = ed.etc.hexToBytes(readHexFile(PROD_PRIVATE, 'Production private key'));
  const derived = hex(await ed.getPublicKeyAsync(secretKey));
  if (derived !== PUBLIC_KEY_HEX) {
    throw new UsageError(
      'The private key does not match packages/license/public-key.hex; apps would reject the key.',
    );
  }

  const keyId = crypto.getRandomValues(new Uint8Array(8));
  const key = await mint(secretKey, {
    edition: editionByte,
    days,
    keyId,
    licensee: await licenseeBytes(email),
  });
  const check = await verifyLicense(key);
  if (!check.valid) throw new Error(`Self-check failed (${check.reason}); key discarded.`);
  console.error(
    `edition ${edition}, issued ${check.info.issuedAt.toISOString().slice(0, 10)}, keyId ${check.info.keyId}`,
  );
  console.log(key);
}

async function verify({ key, test }) {
  if (!key) throw new UsageError('verify needs a key argument.');
  const publicKeyHex = test ? readTestKeypair().publicKeyHex : PUBLIC_KEY_HEX;
  const result = await verifyLicense(key, publicKeyHex);
  if (!result.valid) {
    console.log(JSON.stringify({ valid: false, reason: result.reason }));
    process.exitCode = 1;
    return;
  }
  const { info } = result;
  console.log(
    JSON.stringify(
      { valid: true, ...info, issuedAt: info.issuedAt.toISOString().slice(0, 10) },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------- vectors

function readTestKeypair() {
  const pair = JSON.parse(readFileSync(TEST_KEYPAIR, 'utf8'));
  if (!HEX64.test(pair.privateKeyHex) || !HEX64.test(pair.publicKeyHex)) {
    throw new UsageError(`${TEST_KEYPAIR} is malformed.`);
  }
  return pair;
}

/** Create the TEST keypair once; never overwrite an existing one. */
async function ensureTestKeypair() {
  if (existsSync(TEST_KEYPAIR) && /^\s*\{/.test(readFileSync(TEST_KEYPAIR, 'utf8'))) {
    const pair = readTestKeypair();
    const derived = hex(await ed.getPublicKeyAsync(ed.etc.hexToBytes(pair.privateKeyHex)));
    if (derived !== pair.publicKeyHex) throw new UsageError('test-keypair.json is inconsistent.');
    return pair;
  }
  const secretKey = ed.utils.randomSecretKey();
  const pair = {
    _comment: 'TEST ONLY — never used for real licenses',
    privateKeyHex: hex(secretKey),
    publicKeyHex: hex(await ed.getPublicKeyAsync(secretKey)),
  };
  writeFileSync(TEST_KEYPAIR, `${JSON.stringify(pair, null, 2)}\n`);
  return pair;
}

const fillBytes = (start) => Uint8Array.from({ length: 8 }, (_, i) => (start + i * 7) & 0xff);

async function vectors() {
  const pair = await ensureTestKeypair();
  const secretKey = ed.etc.hexToBytes(pair.privateKeyHex);
  // A second, throw-away key derived from a fixed label so the output stays deterministic.
  const otherSecret = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('polishot-test-other-key')),
  );

  const personalDays = parseDate('2026-01-15');
  const teamDays = parseDate('2026-03-01');
  const personal = {
    edition: 1,
    days: personalDays,
    keyId: fillBytes(0x11),
    licensee: await licenseeBytes('alice@example.com'),
  };
  const team = {
    edition: 2,
    days: teamDays,
    keyId: fillBytes(0xa0),
    licensee: await licenseeBytes('team@example.com'),
  };
  const maxDays = { ...personal, days: 0xffffffff, keyId: fillBytes(0x40) };

  const validCase = (name, key, fields) => ({
    name,
    key,
    valid: true,
    edition: fields.edition === 1 ? 'personal' : 'team',
    issuedDays: fields.days,
    keyIdHex: hex(fields.keyId),
    licenseeHash: hex(fields.licensee),
  });
  const invalidCase = (name, key, reason) => ({ name, key, valid: false, reason });

  const personalKey = await mint(secretKey, personal);
  const teamKey = await mint(secretKey, team);
  const maxDaysKey = await mint(secretKey, maxDays);
  const body = personalKey.slice('PSHOT-'.length);
  const raw = decodeKey(personalKey);
  if (!raw) throw new Error('internal error: freshly minted key does not decode');
  const withBytes = (mutate) => {
    const payload = raw.payload.slice();
    const signature = raw.signature.slice();
    mutate(payload, signature);
    return encodeKey(payload, signature);
  };
  const replaceAt = (text, index, ch) => text.slice(0, index) + ch + text.slice(index + 1);

  const ones = (body.match(/1/g) ?? []).length;
  const zeros = (body.match(/0/g) ?? []).length;
  if (ones < 2 || zeros < 2)
    throw new Error('personal key needs at least two 0 and two 1 characters');
  // 0 -> O/o alternately; 1 -> I, l, L in rotation.
  let seenZero = 0;
  let seenOne = 0;
  const confusable = body.replace(/[01]/g, (ch) =>
    ch === '0' ? 'Oo'[seenZero++ % 2] : 'IlL'[seenOne++ % 3],
  );

  const groups = body.split('-');
  const signedBy = (secret, fields) => mint(secret, fields);

  const cases = [
    validCase('valid-personal', personalKey, personal),
    validCase('valid-team', teamKey, team),
    validCase('valid-max-u32-days', maxDaysKey, maxDays),
    validCase(
      'valid-lowercase-no-group-dashes',
      `pshot-${body.replaceAll('-', '').toLowerCase()}`,
      personal,
    ),
    validCase('valid-without-prefix', body, personal),
    validCase(
      'valid-whitespace-separated',
      `  \t${personalKey.slice(0, 6)}${groups.join(' ')}\r\n`,
      personal,
    ),
    validCase('valid-confusable-O-I-L', `PSHOT-${confusable}`, personal),
    invalidCase(
      'flipped-payload-byte',
      withBytes((p) => (p[7] ^= 0x01)),
      'signature',
    ),
    invalidCase(
      'flipped-signature-byte',
      withBytes((_, s) => (s[10] ^= 0x01)),
      'signature',
    ),
    invalidCase('signed-by-different-key', await signedBy(otherSecret, personal), 'signature'),
    invalidCase('truncated', personalKey.slice(0, -12), 'length'),
    invalidCase('extra-group', `${personalKey}-ABCDEF`, 'length'),
    invalidCase('prefix-only', 'PSHOT-', 'length'),
    invalidCase('empty-string', '', 'length'),
    invalidCase('whitespace-only', ' \t\r\n', 'length'),
    invalidCase('too-long-valid-chars', 'A'.repeat(301), 'length'),
    invalidCase('too-long-bad-chars-length-wins', '!'.repeat(301), 'length'),
    invalidCase('garbage-letter-U', `PSHOT-${replaceAt(body, 21, 'U')}`, 'format'),
    invalidCase('garbage-exclamation-mark', `PSHOT-${replaceAt(body, 43, '!')}`, 'format'),
    invalidCase('garbage-non-ascii', 'PSHOT-日本語', 'format'),
    invalidCase('bad-char-beats-length', 'PSHOT-ABC!', 'format'),
    invalidCase(
      'version-2-correctly-signed',
      await mint(secretKey, { ...personal, version: 2, keyId: fillBytes(0x22) }),
      'version',
    ),
    invalidCase(
      'edition-3-correctly-signed',
      await mint(secretKey, { ...personal, edition: 3, keyId: fillBytes(0x33) }),
      'version',
    ),
    invalidCase(
      'version-2-signed-by-different-key-signature-wins',
      await mint(otherSecret, { ...personal, version: 2, keyId: fillBytes(0x22) }),
      'signature',
    ),
  ];

  // Entitlement vectors (CONTRACTS section 5b). Expected values are computed here with plain arithmetic,
  // independently of the library, then checked against it below. `key` is '' when nothing is activated.
  const WINDOW = 365;
  const U32_MAX = 0xffffffff;
  const until = (fields) => Math.min(fields.days + WINDOW, U32_MAX);
  const covered = (name, key, fields, buildDays) => ({
    name,
    key,
    buildDays,
    pro: true,
    updatesUntilDays: until(fields),
  });
  const expired = (name, key, fields, buildDays) => ({
    name,
    key,
    buildDays,
    pro: false,
    reason: 'updates-expired',
    updatesUntilDays: until(fields),
  });
  const refused = (name, key, buildDays, reason) => ({ name, key, buildDays, pro: false, reason });
  const keyOf = (name) => {
    const found = cases.find((c) => c.name === name);
    if (!found) throw new Error(`entitlement vector refers to unknown case ${name}`);
    return found.key;
  };

  const entitlementCases = [
    covered('personal-build-inside-window', personalKey, personal, personal.days + 180),
    covered('personal-build-on-issue-day', personalKey, personal, personal.days),
    covered('personal-build-before-issue-day', personalKey, personal, personal.days - 30),
    covered('personal-build-on-last-day-inclusive', personalKey, personal, personal.days + WINDOW),
    expired('personal-build-one-day-after', personalKey, personal, personal.days + WINDOW + 1),
    expired('personal-build-years-later', personalKey, personal, personal.days + 4 * WINDOW),
    covered('team-build-inside-window', teamKey, team, team.days + 200),
    covered('team-build-on-last-day-inclusive', teamKey, team, team.days + WINDOW),
    expired('team-build-one-day-after', teamKey, team, team.days + WINDOW + 1),
    covered('max-u32-days-recent-build-saturates', maxDaysKey, maxDays, personal.days + 100),
    covered('max-u32-days-last-possible-build', maxDaysKey, maxDays, U32_MAX),
    refused(
      'invalid-flipped-signature-byte',
      keyOf('flipped-signature-byte'),
      personal.days + 10,
      'invalid',
    ),
    refused(
      'invalid-signed-by-different-key',
      keyOf('signed-by-different-key'),
      personal.days + 10,
      'invalid',
    ),
    refused(
      'invalid-future-version',
      keyOf('version-2-correctly-signed'),
      personal.days + 10,
      'invalid',
    ),
    refused('invalid-garbage-text', 'this is not a licence key', personal.days + 10, 'invalid'),
    refused('no-key-empty-string', '', personal.days + 10, 'no-key'),
    refused('no-key-whitespace-only', ' \t\r\n', personal.days + 10, 'no-key'),
  ];
  // Sanity: the TS implementation must agree with what we just wrote.
  for (const c of cases) {
    const result = await verifyLicense(c.key, pair.publicKeyHex);
    const ok = c.valid ? result.valid : !result.valid && result.reason === c.reason;
    if (!ok)
      throw new Error(`vector "${c.name}" disagrees with verifyLicense: ${JSON.stringify(result)}`);
  }

  for (const e of entitlementCases) {
    const blank = e.key.trim() === '';
    const got = entitlement(
      blank ? null : await verifyLicense(e.key, pair.publicKeyHex),
      e.buildDays,
    );
    const same =
      got.pro === e.pro &&
      got.reason === e.reason &&
      (e.updatesUntilDays === undefined
        ? got.updatesUntil === undefined
        : got.updatesUntil === daysToIso(e.updatesUntilDays));
    if (!same) {
      throw new Error(
        `entitlement vector "${e.name}" disagrees with entitlement(): ${JSON.stringify(got)}`,
      );
    }
  }

  writeFileSync(
    TEST_VECTORS,
    `${JSON.stringify({ publicKeyHex: pair.publicKeyHex, cases, entitlementCases }, null, 2)}\n`,
  );
  console.log(
    `Wrote ${cases.length} vectors and ${entitlementCases.length} entitlement cases to ${TEST_VECTORS}`,
  );
}

// ------------------------------------------------------------------- main

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      force: { type: 'boolean', default: false },
      email: { type: 'string' },
      edition: { type: 'string' },
      date: { type: 'string' },
      test: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(usage);
    return;
  }
  switch (command) {
    case 'init':
      return init(values);
    case 'issue':
      return issue(values);
    case 'verify':
      return verify({ key: rest.join(' '), test: values.test });
    case 'vectors':
      return vectors();
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${usage}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
