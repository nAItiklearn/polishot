import { isValidCard, isValidIPv4, isValidIPv6, looksLikeGenericSecret } from './validators';

export type DetectionKind = 'email' | 'card' | 'ipv4' | 'ipv6' | 'secret';

export interface Match {
  kind: DetectionKind;
  /** Human label shown in the UI, e.g. "Visa card", "GitHub token". */
  label: string;
  start: number;
  end: number;
  value: string;
  confidence: number;
}

interface Candidate extends Match {
  priority: number;
}

/** Hard cap so pathological OCR output can't make detection slow. */
const MAX_LINE = 4096;

const FILE_EXT_TLD = /^(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|js|mjs|cjs|ts|tsx|jsx|css|scss|json|map|html?|md)$/i;

const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9_%+-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}([A-Za-z]{2,24})(?![A-Za-z0-9-])/g;
const CARD = /(?<![\dA-Za-z])\d(?:[ -]?\d){11,18}(?![\dA-Za-z])/g;
const IPV4 = /(?<![\w.:])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)/g;
const IPV6 =
  /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f]{0,4})(?:%[A-Za-z0-9]{1,16})?(?![\w:])/g;
const VERSION_BEFORE = /(?:\bv|\bver|\bversion|\bbuild|\brelease|\brev)\s*[.:]?\s*$/i;

interface SecretRule {
  label: string;
  re: RegExp;
  confidence: number;
}

/** Known credential formats. Prefixes are public and documented by each provider. */
const SECRET_RULES: SecretRule[] = [
  { label: 'OpenAI key', re: /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, confidence: 0.95 },
  { label: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{32,}/g, confidence: 0.97 },
  { label: 'Stripe key', re: /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, confidence: 0.97 },
  { label: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,255}/g, confidence: 0.98 },
  { label: 'GitHub token', re: /github_pat_[A-Za-z0-9_]{50,255}/g, confidence: 0.98 },
  { label: 'Slack token', re: /xox[abposr]-[A-Za-z0-9-]{10,}/g, confidence: 0.95 },
  { label: 'AWS access key', re: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g, confidence: 0.95 },
  { label: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/g, confidence: 0.95 },
  { label: 'GitLab token', re: /glpat-[A-Za-z0-9_-]{20,}/g, confidence: 0.97 },
  { label: 'npm token', re: /npm_[A-Za-z0-9]{36}/g, confidence: 0.97 },
  { label: 'SendGrid key', re: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, confidence: 0.97 },
  { label: 'Hugging Face token', re: /hf_[A-Za-z0-9]{30,}/g, confidence: 0.95 },
  { label: 'Shopify token', re: /shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}/g, confidence: 0.97 },
  { label: 'Twilio key', re: /(?<![A-Za-z0-9])SK[0-9a-fA-F]{32}(?![A-Za-z0-9])/g, confidence: 0.85 },
  {
    label: 'JSON Web Token',
    re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    confidence: 0.95,
  },
  {
    label: 'Private key',
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
    confidence: 0.99,
  },
];

const CONTEXT_SECRET =
  /\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd|pwd|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"',;]{8,256})/dgi;
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/dg;
const GENERIC = /(?<![A-Za-z0-9_\-+/=.])[A-Za-z0-9][A-Za-z0-9_\-+/=]{19,511}(?![A-Za-z0-9_\-+/=])/g;
const PLACEHOLDER = /^(?:[x*•.#_-]+|<.*>?|\$\{?.*|\{\{.*|%.*%|process\.env.*|changeme|example|your[_-].*|null|undefined|true|false|none)$/i;

/** OCR often reads 0 as O and 1 as l/I inside digit runs. Same length, so offsets survive. */
export function fixOcrDigits(text: string): string {
  return text.replace(/(?<=\d[ -]?)[OoIl|](?=[ -]?\d)/g, (c) => (c === 'O' || c === 'o' ? '0' : '1'));
}

function push(out: Candidate[], m: Omit<Candidate, 'value'>, text: string) {
  out.push({ ...m, value: text.slice(m.start, m.end) });
}

export function findMatches(input: string): Match[] {
  if (!input) return [];
  const text = input.length > MAX_LINE ? input.slice(0, MAX_LINE) : input;
  const digitsFixed = fixOcrDigits(text);
  const out: Candidate[] = [];

  for (const rule of SECRET_RULES) {
    for (const m of text.matchAll(rule.re)) {
      push(out, { kind: 'secret', label: rule.label, start: m.index, end: m.index + m[0].length, confidence: rule.confidence, priority: 6 }, text);
    }
  }

  for (const m of text.matchAll(CONTEXT_SECRET)) {
    const val = m[1]!;
    const span = m.indices?.[1];
    if (!span || PLACEHOLDER.test(val)) continue;
    push(out, { kind: 'secret', label: 'Secret value', start: span[0], end: span[1], confidence: 0.85, priority: 4 }, text);
  }

  for (const m of text.matchAll(BEARER)) {
    const span = m.indices?.[1];
    if (!span) continue;
    push(out, { kind: 'secret', label: 'Bearer token', start: span[0], end: span[1], confidence: 0.9, priority: 4 }, text);
  }

  for (const m of text.matchAll(EMAIL)) {
    const tld = m[1]!;
    const local = m[0].slice(0, m[0].indexOf('@'));
    if (FILE_EXT_TLD.test(tld) || local.includes('..')) continue;
    push(out, { kind: 'email', label: 'Email', start: m.index, end: m.index + m[0].length, confidence: 0.92, priority: 5 }, text);
  }

  for (const m of digitsFixed.matchAll(CARD)) {
    const { valid, brand } = isValidCard(m[0]);
    if (!valid) continue;
    push(out, { kind: 'card', label: `${brand} card`, start: m.index, end: m.index + m[0].length, confidence: 0.95, priority: 5 }, text);
  }

  for (const m of text.matchAll(IPV4)) {
    if (!isValidIPv4(m[0])) continue;
    if (VERSION_BEFORE.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    push(out, { kind: 'ipv4', label: 'IPv4 address', start: m.index, end: m.index + m[0].length, confidence: 0.88, priority: 3 }, text);
  }

  for (const m of text.matchAll(IPV6)) {
    if (!isValidIPv6(m[0])) continue;
    push(out, { kind: 'ipv6', label: 'IPv6 address', start: m.index, end: m.index + m[0].length, confidence: 0.88, priority: 3 }, text);
  }

  for (const m of text.matchAll(GENERIC)) {
    if (!looksLikeGenericSecret(m[0])) continue;
    push(out, { kind: 'secret', label: 'Possible token', start: m.index, end: m.index + m[0].length, confidence: 0.65, priority: 1 }, text);
  }

  // Resolve overlaps: higher priority first, then longer span.
  out.sort((a, b) => b.priority - a.priority || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const accepted: Candidate[] = [];
  for (const c of out) {
    if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue;
    accepted.push(c);
  }
  return accepted
    .sort((a, b) => a.start - b.start)
    .map(({ priority: _p, ...m }) => m);
}
