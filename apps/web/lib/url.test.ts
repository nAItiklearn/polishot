import { describe, expect, it } from 'vitest';
import { parseCheckoutUrl, parseOrigin, parseRepo } from './url';

describe('parseCheckoutUrl', () => {
  it('treats empty and missing values as not on sale', () => {
    expect(parseCheckoutUrl(undefined)).toBeNull();
    expect(parseCheckoutUrl('')).toBeNull();
    expect(parseCheckoutUrl('   ')).toBeNull();
  });

  it('accepts https URLs', () => {
    expect(parseCheckoutUrl('https://pay.example.com/buy?id=1')).toBe(
      'https://pay.example.com/buy?id=1',
    );
  });

  it('rejects other schemes and credentials', () => {
    expect(parseCheckoutUrl('http://pay.example.com')).toBeNull();
    expect(parseCheckoutUrl('javascript:alert(1)')).toBeNull();
    expect(parseCheckoutUrl('data:text/html,hi')).toBeNull();
    expect(parseCheckoutUrl('https://user:pw@pay.example.com')).toBeNull();
    expect(parseCheckoutUrl('not a url')).toBeNull();
  });
});

describe('parseRepo', () => {
  it('accepts owner/repo', () => {
    expect(parseRepo('acme/polishot', 'owner/polishot')).toBe('acme/polishot');
    expect(parseRepo(' acme/pol.ish-ot_1 ', 'x/y')).toBe('acme/pol.ish-ot_1');
  });

  it('falls back on anything else', () => {
    expect(parseRepo(undefined, 'owner/polishot')).toBe('owner/polishot');
    expect(parseRepo('', 'owner/polishot')).toBe('owner/polishot');
    expect(parseRepo('https://github.com/a/b', 'owner/polishot')).toBe('owner/polishot');
    expect(parseRepo('a/b/c', 'owner/polishot')).toBe('owner/polishot');
    expect(parseRepo('a/../b', 'owner/polishot')).toBe('owner/polishot');
    expect(parseRepo('a b/c', 'owner/polishot')).toBe('owner/polishot');
  });
});

describe('parseOrigin', () => {
  it('returns the bare origin', () => {
    expect(parseOrigin('https://polishot.app/', 'https://fallback.test')).toBe(
      'https://polishot.app',
    );
    expect(parseOrigin('http://localhost:3000/some/path', 'https://fallback.test')).toBe(
      'http://localhost:3000',
    );
  });

  it('falls back when empty, malformed or not http(s)', () => {
    expect(parseOrigin('', 'https://fallback.test')).toBe('https://fallback.test');
    expect(parseOrigin('nonsense', 'https://fallback.test')).toBe('https://fallback.test');
    expect(parseOrigin('ftp://x.test', 'https://fallback.test')).toBe('https://fallback.test');
  });
});
