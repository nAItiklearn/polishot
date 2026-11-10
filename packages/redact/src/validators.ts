/** Pure validators. No regex backtracking hazards: every input is length-bounded by the caller. */

export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export type CardBrand =
  | 'Visa'
  | 'Mastercard'
  | 'Amex'
  | 'Discover'
  | 'JCB'
  | 'Diners'
  | 'UnionPay'
  | 'Maestro';

export function cardBrand(d: string): CardBrand | null {
  const L = d.length;
  const n2 = Number(d.slice(0, 2));
  const n3 = Number(d.slice(0, 3));
  const n4 = Number(d.slice(0, 4));
  if (d[0] === '4' && (L === 13 || L === 16 || L === 19)) return 'Visa';
  if (((n2 >= 51 && n2 <= 55) || (n4 >= 2221 && n4 <= 2720)) && L === 16) return 'Mastercard';
  if ((n2 === 34 || n2 === 37) && L === 15) return 'Amex';
  if ((n4 === 6011 || n2 === 65 || (n3 >= 644 && n3 <= 649)) && L >= 16 && L <= 19)
    return 'Discover';
  if (n4 >= 3528 && n4 <= 3589 && L >= 16 && L <= 19) return 'JCB';
  if ((n2 === 36 || n2 === 38 || n2 === 39 || (n3 >= 300 && n3 <= 305)) && L >= 14 && L <= 19)
    return 'Diners';
  if (n2 === 62 && L >= 16 && L <= 19) return 'UnionPay';
  if (['50', '56', '57', '58', '63', '67'].includes(d.slice(0, 2)) && L >= 12 && L <= 19)
    return 'Maestro';
  return null;
}

/** Separators must be consistent and group like real printed card numbers. */
function groupingOk(raw: string): boolean {
  const seps = raw.match(/[ -]/g);
  if (!seps) return true;
  if (new Set(seps).size > 1) return false;
  const groups = raw.split(/[ -]/).map((g) => g.length);
  const key = groups.join('-');
  if (key === '4-6-5' || key === '4-6-4') return true; // Amex / Diners
  return groups.every((g, i) => (i === groups.length - 1 ? g >= 1 && g <= 4 : g === 4));
}

export function isValidCard(raw: string): { valid: boolean; brand: CardBrand | null } {
  const digits = raw.replace(/[ -]/g, '');
  if (!/^\d{12,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return { valid: false, brand: null };
  const brand = cardBrand(digits);
  const valid = brand !== null && groupingOk(raw) && luhnValid(digits);
  return { valid, brand: valid ? brand : null };
}

export function isValidIPv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && (p === '0' || p[0] !== '0') && Number(p) <= 255);
}

export function isValidIPv6(input: string): boolean {
  let s = input;
  const pct = s.indexOf('%');
  if (pct !== -1) {
    if (!/^%[A-Za-z0-9]{1,16}$/.test(s.slice(pct))) return false;
    s = s.slice(0, pct);
  }
  if (s.length < 2 || s.length > 45) return false;
  let extraGroups = 0;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isValidIPv4(tail)) return false;
    s = s.slice(0, lastColon + 1) + '0';
    extraGroups = 1; // an IPv4 tail occupies two 16-bit groups
  }
  const pieces = s.split('::');
  if (pieces.length > 2) return false;
  const toGroups = (p: string) => (p === '' ? [] : p.split(':'));
  const head = toGroups(pieces[0] ?? '');
  const rest = pieces.length === 2 ? toGroups(pieces[1] ?? '') : [];
  const all = [...head, ...rest];
  if (!all.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  const count = all.length + extraGroups;
  if (pieces.length === 2) return count <= 7 && all.length >= 1;
  return count === 8;
}

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

type CharClass = 'l' | 'u' | 'd' | 's';
const classOf = (c: string): CharClass =>
  c >= 'a' && c <= 'z' ? 'l' : c >= 'A' && c <= 'Z' ? 'u' : c >= '0' && c <= '9' ? 'd' : 's';

/** Mean length of runs of the same character class. Identifiers have long runs; random tokens short ones. */
export function meanClassRun(s: string): number {
  if (!s) return 0;
  let runs = 1;
  for (let i = 1; i < s.length; i++) if (classOf(s[i]!) !== classOf(s[i - 1]!)) runs++;
  return s.length / runs;
}

/**
 * Heuristic for tokens without a known prefix. Tuned to reject identifiers, hashes,
 * UUIDs, paths and constants while catching random-looking credentials.
 */
export function looksLikeGenericSecret(tok: string): boolean {
  if (tok.length < 20 || tok.length > 512) return false;
  if (/^[0-9a-f]+$/i.test(tok)) return false; // hex hashes, commit SHAs
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tok)) return false;
  if ((tok.match(/\//g)?.length ?? 0) >= 2) return false; // paths / URLs
  if (/^[A-Z0-9_]+$/.test(tok) && tok.includes('_')) return false; // CONSTANT_NAMES
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(tok)) return false; // kebab-case slugs
  const classes = new Set([...tok].map(classOf));
  if (!classes.has('d')) return false;
  const h = shannonEntropy(tok);
  if (h < 3.5) return false;
  if (meanClassRun(tok) > 2.6) return false;
  return classes.size >= 3 || (tok.length >= 32 && h >= 4);
}
