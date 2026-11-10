import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as ed from '@noble/ed25519';
import { describe, expect, it } from 'vitest';
import { ALPHABET, decodeBase32, encodeBase32 } from '../src/base32';
import {
  PUBLIC_KEY_HEX,
  decodeKey,
  encodeKey,
  licenseeHash,
  verifyLicense,
  type VerifyResult,
} from '../src/index';

interface VectorCase {
  name: string;
  key: string;
  valid: boolean;
  reason?: 'format' | 'length' | 'version' | 'signature';
  edition?: 'personal' | 'team';
  issuedDays?: number;
  keyIdHex?: string;
  licenseeHash?: string;
}
interface Vectors {
  publicKeyHex: string;
  cases: VectorCase[];
}

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const vectors = JSON.parse(read('test-vectors.json')) as Vectors;
const testKeypair = JSON.parse(read('test-keypair.json')) as {
  _comment: string;
  privateKeyHex: string;
  publicKeyHex: string;
};

/** Deterministic PRNG so a fuzz failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('shared test vectors', () => {
  it('uses the committed TEST keypair and covers every outcome', () => {
    expect(vectors.publicKeyHex).toBe(testKeypair.publicKeyHex);
    expect(testKeypair._comment).toBe('TEST ONLY — never used for real licenses');
    expect(vectors.publicKeyHex).not.toBe(PUBLIC_KEY_HEX);
    const reasons = new Set(vectors.cases.filter((c) => !c.valid).map((c) => c.reason));
    expect([...reasons].sort()).toEqual(['format', 'length', 'signature', 'version']);
    const editions = new Set(vectors.cases.filter((c) => c.valid).map((c) => c.edition));
    expect([...editions].sort()).toEqual(['personal', 'team']);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(11);
  });

  for (const c of vectors.cases) {
    it(`vector: ${c.name}`, async () => {
      const result = await verifyLicense(c.key, vectors.publicKeyHex);
      if (!c.valid) {
        expect(result).toEqual({ valid: false, reason: c.reason });
        return;
      }
      expect(result.valid).toBe(true);
      if (!result.valid) return;
      expect(result.info.version).toBe(1);
      expect(result.info.edition).toBe(c.edition);
      // A JS Date holds at most 100,000,000 days; larger u32 values are clamped.
      expect(result.info.issuedAt.getTime() / 86_400_000).toBe(
        Math.min(c.issuedDays ?? -1, 100_000_000),
      );
      expect(result.info.keyId).toBe(c.keyIdHex);
      expect(result.info.licenseeHash).toBe(c.licenseeHash);
    });
  }

  it('no vector verifies against the production public key', async () => {
    for (const c of vectors.cases) {
      const result = await verifyLicense(c.key);
      expect(result.valid, c.name).toBe(false);
    }
  });

  it('the valid vectors carry the hashes of the documented test emails', async () => {
    const byName = new Map(vectors.cases.map((c) => [c.name, c]));
    expect(byName.get('valid-personal')?.licenseeHash).toBe(
      await licenseeHash('alice@example.com'),
    );
    expect(byName.get('valid-team')?.licenseeHash).toBe(await licenseeHash('team@example.com'));
  });
});

describe('PUBLIC_KEY_HEX', () => {
  it('equals packages/license/public-key.hex (trimmed)', () => {
    expect(PUBLIC_KEY_HEX).toBe(read('public-key.hex').trim());
    expect(PUBLIC_KEY_HEX).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is not the test key', () => {
    expect(PUBLIC_KEY_HEX).not.toBe(testKeypair.publicKeyHex);
  });
});

describe('crockford base32', () => {
  // RFC 4648 section 10 vectors, translated from the RFC alphabet to Crockford's.
  const RFC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const rfcVectors: [string, string][] = [
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  const toCrockford = (rfc: string) =>
    [...rfc].map((ch) => ALPHABET.charAt(RFC.indexOf(ch))).join('');

  it('matches the RFC 4648 vectors', () => {
    for (const [text, rfc] of rfcVectors) {
      const bytes = new TextEncoder().encode(text);
      expect(encodeBase32(bytes)).toBe(toCrockford(rfc));
      expect(decodeBase32(toCrockford(rfc))).toEqual(bytes);
    }
  });

  it('has the contract alphabet', () => {
    expect(ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  });

  it('decodes case-insensitively, ignores whitespace and dashes, maps O/I/L', () => {
    const bytes = Uint8Array.from([0x00, 0x44, 0x32, 0x14, 0xc7, 0x42, 0x54, 0xb6]);
    const canonical = encodeBase32(bytes);
    expect(canonical).toBe('0123456789ABCDEFGHJKMNPQ'.slice(0, canonical.length));
    expect(decodeBase32(canonical.toLowerCase())).toEqual(bytes);
    expect(decodeBase32(canonical.replace(/(.{3})/g, '$1 - \n\t'))).toEqual(bytes);
    expect(decodeBase32('OIL')).toEqual(decodeBase32('011'));
    expect(decodeBase32('oil')).toEqual(decodeBase32('011'));
  });

  it('rejects U and every character outside the alphabet', () => {
    for (const bad of ['U', 'u', '!', '_', ' ', '–', 'é', '日', '\0', '=', '+']) {
      expect(decodeBase32(`0${bad}0`), JSON.stringify(bad)).toBeNull();
    }
  });

  it('round-trips random bytes of every length', () => {
    const rand = mulberry32(7);
    for (let len = 0; len < 200; len++) {
      const bytes = Uint8Array.from({ length: len }, () => Math.floor(rand() * 256));
      expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    }
  });
});

describe('encodeKey / decodeKey', () => {
  const rand = mulberry32(42);
  const randomBytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));

  it('round-trips and produces PSHOT- plus groups of 6', () => {
    for (let i = 0; i < 200; i++) {
      const payload = randomBytes(30);
      const signature = randomBytes(64);
      const key = encodeKey(payload, signature);
      expect(key).toMatch(
        /^PSHOT-[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{6})*(-[0-9A-HJKMNP-TV-Z]{1,6})?$/,
      );
      const decoded = decodeKey(key);
      expect(decoded).not.toBeNull();
      expect(decoded?.payload).toEqual(payload);
      expect(decoded?.signature).toEqual(signature);
    }
  });

  it('decodes messy but equivalent text forms to the same bytes', () => {
    const payload = randomBytes(30);
    const signature = randomBytes(64);
    const key = encodeKey(payload, signature);
    const body = key.slice('PSHOT-'.length);
    const forms = [
      key.toLowerCase(),
      body,
      `  ${key}\n`,
      `pshot-${body.replaceAll('-', '')}`,
      `PsHoT-${body.replaceAll('-', ' ')}`,
      key.replaceAll('0', 'O').replaceAll('1', 'l'),
    ];
    for (const form of forms) {
      expect(decodeKey(form), form).toEqual({ payload, signature });
    }
  });

  it('returns null instead of throwing on bad input', () => {
    const key = encodeKey(randomBytes(30), randomBytes(64));
    expect(decodeKey('')).toBeNull();
    expect(decodeKey(key.slice(0, -7))).toBeNull();
    expect(decodeKey(`${key}-AAAAAA`)).toBeNull();
    expect(decodeKey(key.replace('-', 'U'))).toBeNull();
    expect(decodeKey('A'.repeat(301))).toBeNull();
    expect(decodeKey(null as unknown as string)).toBeNull();
  });

  it('refuses wrong-sized inputs when encoding', () => {
    expect(() => encodeKey(new Uint8Array(29), new Uint8Array(64))).toThrow(RangeError);
    expect(() => encodeKey(new Uint8Array(30), new Uint8Array(63))).toThrow(RangeError);
  });
});

describe('verifyLicense edge cases', () => {
  const personal = vectors.cases.find((c) => c.name === 'valid-personal')!;

  it('accepts only the first 300 characters of input', async () => {
    const padded = `${personal.key}${' '.repeat(300 - personal.key.length)}`;
    expect(padded.length).toBe(300);
    expect((await verifyLicense(padded, vectors.publicKeyHex)).valid).toBe(true);
    expect(await verifyLicense(`${padded} `, vectors.publicKeyHex)).toEqual({
      valid: false,
      reason: 'length',
    });
  });

  it('reports a bad character before a bad length', async () => {
    expect(await verifyLicense('PSHOT-U', vectors.publicKeyHex)).toEqual({
      valid: false,
      reason: 'format',
    });
  });

  it('does not throw for a malformed public key', async () => {
    for (const badKey of ['', 'zz', '00', 'f'.repeat(63), 'f'.repeat(65), 'f'.repeat(64)]) {
      const result = await verifyLicense(personal.key, badKey);
      expect(result.valid).toBe(false);
    }
  });

  it('rejects a signature made by another key even if structurally perfect', async () => {
    const secret = ed.utils.randomSecretKey();
    const payload = new Uint8Array(30);
    payload[0] = 1;
    payload[1] = 1;
    const key = encodeKey(payload, await ed.signAsync(payload, secret));
    expect(await verifyLicense(key, vectors.publicKeyHex)).toEqual({
      valid: false,
      reason: 'signature',
    });
    const ownPublic = ed.etc.bytesToHex(await ed.getPublicKeyAsync(secret));
    expect((await verifyLicense(key, ownPublic)).valid).toBe(true);
  });

  it('rejects a non-canonical signature scalar (S + L)', async () => {
    const secret = ed.etc.hexToBytes(testKeypair.privateKeyHex);
    const payload = new Uint8Array(30);
    payload[0] = 1;
    payload[1] = 2;
    const signature = await ed.signAsync(payload, secret);
    expect((await verifyLicense(encodeKey(payload, signature), vectors.publicKeyHex)).valid).toBe(
      true,
    );
    // S' = S + L is the same point equation but not a canonical scalar.
    const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i] ?? 0);
    const malleated = signature.slice();
    let t = s + L;
    for (let i = 32; i < 64; i++) {
      malleated[i] = Number(t & 0xffn);
      t >>= 8n;
    }
    expect(await verifyLicense(encodeKey(payload, malleated), vectors.publicKeyHex)).toEqual({
      valid: false,
      reason: 'signature',
    });
  });
});

describe('licenseeHash', () => {
  it('is the first 16 bytes of SHA-256 of the normalised email', async () => {
    const expected = createHash('sha256').update('alice@example.com').digest('hex').slice(0, 32);
    expect(await licenseeHash('alice@example.com')).toBe(expected);
    expect(await licenseeHash('  Alice@Example.COM \n')).toBe(expected);
    expect(await licenseeHash('alice@example.com')).toMatch(/^[0-9a-f]{32}$/);
    expect(await licenseeHash('bob@example.com')).not.toBe(expected);
  });
});

describe('fuzz: never throws on user input', () => {
  it('survives 1000 random garbage inputs', async () => {
    const rand = mulberry32(2024);
    const personal = vectors.cases.find((c) => c.name === 'valid-personal')!.key;
    const pools = [
      ALPHABET,
      `${ALPHABET}${ALPHABET.toLowerCase()}OILoil -\t\r\n`,
      'U!@#$%^&*()_+=[]{};:\'",.<>/?\\|`~',
      '日本語🙂\u0000 –﻿\ud800',
    ];
    const pick = (s: string) => s.charAt(Math.floor(rand() * s.length));

    for (let i = 0; i < 1000; i++) {
      let input: unknown;
      const mode = i % 6;
      if (mode === 0) {
        input = Array.from({ length: Math.floor(rand() * 400) }, () => pick(pools[0] ?? '')).join(
          '',
        );
      } else if (mode === 1) {
        input = `PSHOT-${Array.from({ length: 140 + Math.floor(rand() * 20) }, () => pick(pools[1] ?? '')).join('')}`;
      } else if (mode === 2) {
        const pool = pools[Math.floor(rand() * pools.length)] ?? '';
        input = Array.from({ length: Math.floor(rand() * 350) }, () => pick(pool)).join('');
      } else if (mode === 3) {
        // a valid key with a few random characters replaced
        const chars = [...personal];
        for (let n = 0; n < 1 + Math.floor(rand() * 4); n++) {
          chars[Math.floor(rand() * chars.length)] = pick(`${pools[0]}${pools[2]}`);
        }
        input = chars.join('');
      } else if (mode === 4) {
        // a valid key cut at a random point
        input = personal.slice(0, Math.floor(rand() * personal.length));
      } else {
        const odd: unknown[] = [
          null,
          undefined,
          0,
          1,
          NaN,
          {},
          [],
          [personal],
          true,
          Symbol.iterator,
        ];
        input = odd[Math.floor(rand() * odd.length)];
      }

      // Any throw here fails the test.
      const result: VerifyResult = await verifyLicense(input as string, vectors.publicKeyHex);
      // A mutated key may rarely still verify (e.g. only whitespace/case changed); garbage must not.
      if (mode !== 3 && mode !== 4) expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(['format', 'length', 'version', 'signature']).toContain(result.reason);
      }
    }
  });
});
