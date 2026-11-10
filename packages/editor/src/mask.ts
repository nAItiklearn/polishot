import type { DetectionKind } from './types';

const DOT = '•';
const dots = (n: number) => DOT.repeat(Math.max(1, n));

/**
 * A short, masked preview of a detected value for the redaction list, e.g. `••••1111` for a card. Shows
 * only what helps the user recognise the match (the last four digits, the domain, a key prefix) and
 * never the whole secret.
 */
export function maskPreview(kind: DetectionKind, value: string): string {
  const v = String(value);
  switch (kind) {
    case 'card': {
      const digits = v.replace(/\D/g, '');
      return `${dots(4)}${digits.slice(-4)}`;
    }
    case 'email': {
      const at = v.lastIndexOf('@');
      if (at < 1) return dots(6);
      const local = v.slice(0, at);
      const domain = v.slice(at + 1);
      const tld = domain.slice(domain.lastIndexOf('.'));
      return `${local[0]}${dots(3)}@${dots(3)}${tld.length > 1 && tld.length <= 8 ? tld : ''}`;
    }
    case 'ipv4': {
      const parts = v.split('.');
      return parts.length === 4 ? `${dots(3)}.${dots(3)}.${dots(3)}.${parts[3]}` : dots(6);
    }
    case 'ipv6': {
      const groups = v.split(':').filter(Boolean);
      const last = groups[groups.length - 1];
      return last ? `${dots(4)}:${dots(4)}:…:${last.slice(-4)}` : dots(6);
    }
    case 'secret':
    default: {
      if (v.length < 12) return dots(8);
      const prefix = /^([A-Za-z]{2,6}[_-])/.exec(v)?.[1] ?? v.slice(0, 3);
      return `${prefix}${dots(6)}${v.slice(-2)}`;
    }
  }
}
