/**
 * Crockford base32, no padding (CONTRACTS section 3).
 *
 * Alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O, U). Decoding is case-insensitive,
 * ignores ASCII whitespace and `-`, maps `O -> 0` and `I`/`L` -> `1`, and rejects everything else
 * (including `U`). Bits left over after the last full byte are padding and are ignored.
 */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const DECODE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
    table[ALPHABET.toLowerCase().charCodeAt(i)] = i;
  }
  for (const c of 'Oo') table[c.charCodeAt(0)] = 0;
  for (const c of 'IiLl') table[c.charCodeAt(0)] = 1;
  return table;
})();

/** Space, \t, \n, \v, \f, \r. Deliberately ASCII-only so every implementation agrees. */
function isSeparator(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0x2d;
}

export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((acc >> bits) & 31);
    }
  }
  if (bits > 0) out += ALPHABET.charAt((acc << (5 - bits)) & 31);
  return out;
}

/** Returns `null` when the text contains a character outside the (lenient) alphabet. */
export function decodeBase32(text: string): Uint8Array | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isSeparator(code)) continue;
    const value = code < 128 ? (DECODE[code] ?? -1) : -1;
    if (value < 0) return null;
    acc = ((acc << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
