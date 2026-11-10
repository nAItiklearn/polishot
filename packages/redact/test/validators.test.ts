import { describe, expect, it } from 'vitest';
import {
  cardBrand,
  isValidCard,
  isValidIPv4,
  isValidIPv6,
  looksLikeGenericSecret,
  luhnValid,
  shannonEntropy,
} from '../src';
import { fixOcrDigits } from '../src/patterns';

describe('luhn', () => {
  it('accepts known test numbers', () => {
    for (const n of ['4111111111111111', '5555555555554444', '378282246310005', '6011111111111117', '30569309025904', '3530111333300000']) {
      expect(luhnValid(n)).toBe(true);
    }
  });
  it('rejects altered numbers and bad input', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('41111')).toBe(false);
    expect(luhnValid('4111a11111111111')).toBe(false);
  });
});

describe('card', () => {
  it('detects brands', () => {
    expect(cardBrand('4111111111111111')).toBe('Visa');
    expect(cardBrand('5555555555554444')).toBe('Mastercard');
    expect(cardBrand('378282246310005')).toBe('Amex');
    expect(cardBrand('1234567890123456')).toBe(null);
  });
  it('requires consistent grouping', () => {
    expect(isValidCard('4111 1111 1111 1111').valid).toBe(true);
    expect(isValidCard('4111-1111 1111-1111').valid).toBe(false);
    expect(isValidCard('41 1111 1111 111111').valid).toBe(false);
    expect(isValidCard('3782 822463 10005').valid).toBe(true);
  });
  it('rejects repeated digits', () => {
    expect(isValidCard('0000000000000000').valid).toBe(false);
  });
});

describe('ip', () => {
  it('ipv4', () => {
    expect(isValidIPv4('192.168.0.1')).toBe(true);
    expect(isValidIPv4('256.1.1.1')).toBe(false);
    expect(isValidIPv4('01.1.1.1')).toBe(false);
    expect(isValidIPv4('1.1.1')).toBe(false);
  });
  it('ipv6', () => {
    for (const ok of ['::1', '2001:db8::1', 'fe80::1%eth0', '::ffff:1.2.3.4', '1:2:3:4:5:6:7:8']) {
      expect(isValidIPv6(ok), ok).toBe(true);
    }
    for (const bad of ['1:2:3', '1::2::3', '12:30:45', '00:1A:2B:3C:4D:5E', 'g::1', '1:2:3:4:5:6:7:8:9', '::']) {
      expect(isValidIPv6(bad), bad).toBe(false);
    }
  });
});

describe('entropy + generic secrets', () => {
  it('computes entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeCloseTo(2);
  });
  it('separates tokens from identifiers', () => {
    expect(looksLikeGenericSecret('q8Zt3LmP0xV7bN2kR9sW4yHc')).toBe(true);
    expect(looksLikeGenericSecret('getUserProfileSettingsById')).toBe(false);
    expect(looksLikeGenericSecret('9fceb02d0ae598e95dc970b74767f19372d61af8')).toBe(false);
    expect(looksLikeGenericSecret('MAX_CONNECTIONS_PER_HOST_2')).toBe(false);
  });
});

describe('ocr digit repair', () => {
  it('maps O and l inside digit runs only', () => {
    expect(fixOcrDigits('4111 1O11 1l11')).toBe('4111 1011 1111');
    expect(fixOcrDigits('Order Of 1O')).toBe('Order Of 1O');
  });
});
