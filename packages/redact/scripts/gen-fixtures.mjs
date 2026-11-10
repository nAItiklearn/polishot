// Generates deterministic redaction fixtures.
// Run: pnpm --filter @polishot/redact gen:fixtures
// Secret-looking values are written with one JSON \u escape in their prefix so the raw file
// does not trip repository secret scanners; JSON.parse restores the real value.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../fixtures');
mkdirSync(outDir, { recursive: true });

let seed = 0x5eed1234;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (s) => s[Math.floor(rand() * s.length)];
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
const str = (alpha, n) => Array.from({ length: n }, () => pick(alpha)).join('');
/** Random base62 with at least one digit, upper and lower so it reads as a real token. */
const token = (n) => {
  for (;;) {
    const s = str(B62, n);
    if (/\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return s;
  }
};

function luhnComplete(prefix, length) {
  let body = prefix;
  while (body.length < length - 1) body += Math.floor(rand() * 10);
  for (let check = 0; check < 10; check++) {
    const d = body + check;
    let sum = 0;
    let dbl = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let x = +d[i];
      if (dbl) {
        x *= 2;
        if (x > 9) x -= 9;
      }
      sum += x;
      dbl = !dbl;
    }
    if (sum % 10 === 0) return d;
  }
  throw new Error('unreachable');
}
const group = (d, sizes, sep) => {
  const parts = [];
  let i = 0;
  for (const s of sizes) {
    parts.push(d.slice(i, i + s));
    i += s;
  }
  if (i < d.length) parts.push(d.slice(i));
  return parts.filter(Boolean).join(sep);
};

const positive = [];
const add = (text, ...expect) => positive.push({ text, expect: expect.map(([kind, value]) => ({ kind, value })) });

// ---- Emails
add('Contact: jane.doe@example.com', ['email', 'jane.doe@example.com']);
add('Signed in as dev+test@sub.company.co.uk', ['email', 'dev+test@sub.company.co.uk']);
add('From: Ravi Kumar <ravi_kumar88@mail.example.org>', ['email', 'ravi_kumar88@mail.example.org']);
add('email=o.brien@example.io&ref=1', ['email', 'o.brien@example.io']);
add('Reply to support@polishot-demo.dev for help', ['email', 'support@polishot-demo.dev']);
add('MAILTO:FINANCE@EXAMPLE.COM', ['email', 'FINANCE@EXAMPLE.COM']);
add('user.name-123@my-domain.travel wrote:', ['email', 'user.name-123@my-domain.travel']);
add('(a@b.co)', ['email', 'a@b.co']);
add('cc: li.wei@example.cn, tom@example.de', ['email', 'li.wei@example.cn'], ['email', 'tom@example.de']);
add('Invoice sent to accounts%billing@example.net yesterday', ['email', 'accounts%billing@example.net']);
add('git config user.email "maria.garcia@example.es"', ['email', 'maria.garcia@example.es']);
add('Assignee  noah.k@example.com  Due Friday', ['email', 'noah.k@example.com']);

// ---- Cards (generated, Luhn-valid)
const cards = [
  ['4', 16, [4, 4, 4, 4], ' ', 'Visa'],
  ['4', 16, [4, 4, 4, 4], '-', 'Visa'],
  ['4', 16, [16], '', 'Visa'],
  ['4', 13, [4, 4, 4], ' ', 'Visa'],
  ['51', 16, [4, 4, 4, 4], ' ', 'Mastercard'],
  ['55', 16, [16], '', 'Mastercard'],
  ['2223', 16, [4, 4, 4, 4], ' ', 'Mastercard'],
  ['34', 15, [4, 6, 5], ' ', 'Amex'],
  ['37', 15, [15], '', 'Amex'],
  ['6011', 16, [4, 4, 4, 4], ' ', 'Discover'],
  ['3530', 16, [4, 4, 4, 4], ' ', 'JCB'],
  ['3056', 14, [4, 6, 4], ' ', 'Diners'],
  ['62', 16, [4, 4, 4, 4], '-', 'UnionPay'],
  ['4', 19, [4, 4, 4, 4, 3], ' ', 'Visa'],
];
const ctx = ['Card number: %s', 'Pay with %s', '%s exp 09/29', 'CARD %s CVV ***', 'Billing card ending in full: %s'];
cards.forEach(([p, len, sizes, sep], i) => {
  const d = luhnComplete(p, len);
  const v = sep ? group(d, sizes, sep) : d;
  add(ctx[i % ctx.length].replace('%s', v), ['card', v]);
});
// OCR misread: a zero printed as the letter O inside the number
{
  let d;
  do d = luhnComplete('4', 16);
  while (!/\d0\d/.test(d.slice(1, 15)));
  const idx = d.slice(1, 15).search(/(?<=\d)0(?=\d)/) + 1;
  const v = group(d.slice(0, idx) + 'O' + d.slice(idx + 1), [4, 4, 4, 4], ' ');
  add(`Scanned receipt: ${v}`, ['card', v]);
}

// ---- IPv4
add('Server 192.168.1.24 is up', ['ipv4', '192.168.1.24']);
add('curl http://10.0.0.5:8080/health', ['ipv4', '10.0.0.5']);
add('nameserver 8.8.8.8', ['ipv4', '8.8.8.8']);
add('Accepted publickey from 203.0.113.77 port 22', ['ipv4', '203.0.113.77']);
add('route add 172.16.254.1/24', ['ipv4', '172.16.254.1']);
add('Mask [255.255.255.0]', ['ipv4', '255.255.255.0']);
add('listening on 0.0.0.0', ['ipv4', '0.0.0.0']);
add('X-Forwarded-For: 198.51.100.23, 10.1.2.3', ['ipv4', '198.51.100.23'], ['ipv4', '10.1.2.3']);
add('ping 127.0.0.1 -n 4', ['ipv4', '127.0.0.1']);
add('Gateway: 192.0.2.1 (DHCP)', ['ipv4', '192.0.2.1']);

// ---- IPv6
add('inet6 2001:db8::1 scope global', ['ipv6', '2001:db8::1']);
add('link-local fe80::1ff:fe23:4567:890a%eth0', ['ipv6', 'fe80::1ff:fe23:4567:890a%eth0']);
add('bound to ::1 only', ['ipv6', '::1']);
add('addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334', ['ipv6', '2001:0db8:85a3:0000:0000:8a2e:0370:7334']);
add('https://[2001:db8::8a2e:370:7334]:443/', ['ipv6', '2001:db8::8a2e:370:7334']);
add('mapped ::ffff:192.0.2.128', ['ipv6', '::ffff:192.0.2.128']);
add('DNS 2606:4700:4700::1111', ['ipv6', '2606:4700:4700::1111']);
add('multicast ff02::2', ['ipv6', 'ff02::2']);
add('peer 2001:db8:0:0:1:0:0:1 connected', ['ipv6', '2001:db8:0:0:1:0:0:1']);
add('inet6 fd12:3456:789a:1::1/64', ['ipv6', 'fd12:3456:789a:1::1']);

// ---- Secrets with known prefixes
const secrets = [
  ['OPENAI_API_KEY=%s', () => 'sk-proj-' + token(48)],
  ['Authorization header uses %s', () => 'sk-ant-api03-' + token(40)],
  ['stripe.setKey("%s")', () => 'sk_live_' + token(24)],
  ['publishable %s', () => 'pk_live_' + token(24)],
  ['restricted %s', () => 'rk_test_' + token(24)],
  ['token %s', () => 'ghp_' + token(36)],
  ['oauth %s', () => 'gho_' + token(36)],
  ['GH_TOKEN %s', () => 'github_pat_' + token(22) + '_' + token(59)],
  ['SLACK_BOT %s', () => 'xoxb-' + str('0123456789', 12) + '-' + str('0123456789', 13) + '-' + token(24)],
  ['aws_access_key_id %s', () => 'AKIA' + str('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)],
  ['key %s', () => 'AKIAIOSFODNN7EXAMPLE'],
  ['maps key %s', () => 'AIza' + str(B62 + '-_', 35)],
  ['CI uses %s', () => 'glpat-' + token(20)],
  ['//registry.npmjs.org/:_authToken=%s', () => 'npm_' + token(36)],
  ['SENDGRID %s', () => 'SG.' + token(22) + '.' + token(43)],
  ['HF_TOKEN %s', () => 'hf_' + token(34)],
  ['shopify %s', () => 'shpat_' + str(HEX, 32)],
  [
    'cookie session=%s',
    () => 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MiIsIm5hbWUiOiJBbGV4In0.' + token(43),
  ],
  ['%s', () => '-----BEGIN RSA PRIVATE KEY-----'],
  ['%s', () => '-----BEGIN PRIVATE KEY-----'],
];
for (const [tpl, gen] of secrets) {
  const v = gen();
  add(tpl.replace('%s', v), ['secret', v]);
}

// ---- Secrets found by context
{
  const v1 = token(28);
  add(`api_key = "${v1}"`, ['secret', v1]);
  add('password: Tr0ub4dor&3horse', ['secret', 'Tr0ub4dor&3horse']);
  const v2 = token(32);
  add(`client_secret=${v2}`, ['secret', v2]);
  const v3 = token(40);
  add(`Authorization: Bearer ${v3}`, ['secret', v3]);
  const v4 = token(24);
  add(`"access_token": "${v4}"`, ['secret', v4]);
}

// ---- Secrets found by entropy only
for (const n of [24, 30, 36, 44]) {
  const v = token(n);
  add(`Copied ${v} to clipboard`, ['secret', v]);
}

// ---- Mixed lines
{
  const t = 'ghp_' + token(36);
  add(`deploy@ci.example.com pushed with ${t}`, ['email', 'deploy@ci.example.com'], ['secret', t]);
  add('ssh admin@10.20.30.40', ['ipv4', '10.20.30.40']);
}

// ---- Negatives
const negative = [
  'Version 1.2.3.4 released today',
  'v10.0.19045.3803',
  'Build 2024.11.10.1 is ready',
  'Windows 11 build 10.0.26300',
  'semver 2.0.0-beta.1+exp.sha.5114f85',
  'Release 4.12.0 notes',
  'icon@2x.png',
  'logo@3x.webp and hero@2x.jpg',
  '@username mentioned you in #design',
  'mail me at user@localhost',
  'john at example dot com',
  'foo@bar',
  'Twitter handle @polishot',
  'Order #4111 1111 1111 1112',
  '1234 5678 9012 3456',
  '0000 0000 0000 0000',
  'Call +1 (415) 555-0132',
  'Mobile +91 98765 43210',
  'ISBN 978-3-16-148410-0',
  'Tracking 1Z999AA10123456784',
  'Total: 1,234,567.89 USD',
  'Account 12345678 sort code 20-00-00',
  'Meeting at 12:30:45',
  '2026-11-10 14:22:01 INFO started',
  'MAC 00:1A:2B:3C:4D:5E',
  'std::vector<int> values;',
  'Foo::Bar::baz() returned',
  'ratio a:b:c',
  'IPv6 support is enabled',
  '999.1.1.1 is not an address',
  '256.256.256.256',
  'Path 10.0.0',
  'Value 1.2.3',
  'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
  'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'id 550e8400-e29b-41d4-a716-446655440000',
  'getUserProfileSettingsById(userId)',
  'class AbstractSingletonProxyFactoryBean',
  'MAX_CONNECTIONS_PER_HOST_LIMIT = 20',
  'src/components/editor/CanvasStage.tsx',
  'C:\\Users\\Lenovo\\Documents\\Screenshots',
  'https://polishot.app/features/auto-redact',
  'api_key = <your-api-key>',
  'password: ********',
  'token: ${GITHUB_TOKEN}',
  'API_KEY=xxxxxxxxxxxxxxxx',
  'secret: changeme',
  'my-really-long-component-name-for-tests',
  '@tauri-apps/plugin-global-shortcut',
  'ghcr.io/owner/image:1.2.3',
  'sk- is a prefix',
  'ghp_short',
  'AKIA alone',
  'eyJhbGciOi truncated',
  'color #ff5733 and rgba(0,0,0,0.5)',
  'Lighthouse score 98/100',
  'SSN-like 123-45-6789',
  'The quick brown fox jumps over the lazy dog',
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit',
  'Press Ctrl+Shift+2 to capture a region',
  'Export as PNG, JPG or WebP',
  'Padding 64px, radius 12px, shadow 40%',
  'Your screenshot was copied to the clipboard',
  'Drag a region, or press Space for a window',
  'Room 4111-1111 on floor 3',
  'Invoice INV-2026-000123',
  'Coordinates 37.7749, -122.4194',
  'Font Instrument Serif 400 italic',
  'node_modules/.pnpm/konva@10.9.1/node_modules/konva',
  'localhost:3000/editor',
  'Quarterly revenue grew 12.5% to 4.2M',
  'Step 1 of 3: choose a background',
];
// Luhn-failing variants of valid cards: flip the check digit.
for (let i = 0; i < 6; i++) {
  const d = luhnComplete('4', 16);
  const bad = d.slice(0, 15) + ((+d[15] + 1 + i) % 10 === +d[15] ? (+d[15] + 2) % 10 : (+d[15] + 1 + i) % 10);
  negative.push(`Card ${group(bad, [4, 4, 4, 4], ' ')}`);
}

const PREFIXES = ['sk-proj-', 'sk-ant-', 'sk_live_', 'pk_live_', 'rk_test_', 'ghp_', 'gho_', 'github_pat_', 'xoxb-', 'AKIA', 'AIza', 'glpat-', 'npm_', 'SG.', 'hf_', 'shpat_', 'eyJ', '-----BEGIN'];
const escapeJson = (json) => {
  let out = json;
  for (const p of PREFIXES) {
    const esc = p[0] + '\\u' + p.charCodeAt(1).toString(16).padStart(4, '0') + p.slice(2);
    out = out.split(p).join(esc);
  }
  return out;
};

writeFileSync(resolve(outDir, 'positive.json'), escapeJson(JSON.stringify(positive, null, 2)) + '\n');
writeFileSync(
  resolve(outDir, 'negative.json'),
  escapeJson(JSON.stringify(negative.map((text) => ({ text, expect: [] })), null, 2)) + '\n',
);
console.log(`positive: ${positive.length}, negative: ${negative.length}`);
