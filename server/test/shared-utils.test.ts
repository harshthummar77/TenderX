import { describe, expect, it } from 'vitest';
import {
  SHARED_PACKAGE_VERSION,
  fiscalYear,
  fiscalYearRange,
  formatIndianNumber,
  formatMoney,
  gstinChecksum,
  numberToIndianWords,
  validateGstin,
} from '@tb/shared';

/** Proves the workspace link: the server can import the compiled shared package. */
describe('@tb/shared link', () => {
  it('is importable from the server workspace', () => {
    expect(SHARED_PACKAGE_VERSION).toBe('1.0.0');
  });
});

describe('validateGstin', () => {
  it('accepts a structurally valid GSTIN with a correct check digit', () => {
    const result = validateGstin('27AAPFU0939F1ZV');
    expect(result.valid).toBe(true);
    expect(result.stateCode).toBe('27');
    expect(result.stateName).toBe('Maharashtra');
    expect(result.pan).toBe('AAPFU0939F');
  });

  it('is case-insensitive and trims', () => {
    expect(validateGstin('  27aapfu0939f1zv ').valid).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(validateGstin('27AAPFU0939F1Z')).toMatchObject({ valid: false, reason: 'length' });
  });

  it('rejects a bad structure', () => {
    // 14th character must be Z
    expect(validateGstin('27AAPFU0939F1AV')).toMatchObject({ valid: false, reason: 'structure' });
  });

  it('rejects an unknown state code', () => {
    // 99 is not a state; keep the rest of the string well-formed
    expect(validateGstin('99AAPFU0939F1ZV')).toMatchObject({ valid: false, reason: 'state_code' });
  });

  it('rejects a wrong check digit', () => {
    expect(validateGstin('27AAPFU0939F1ZA')).toMatchObject({ valid: false, reason: 'checksum' });
  });

  it('computes the check digit', () => {
    expect(gstinChecksum('27AAPFU0939F1Z')).toBe('V');
  });
});

describe('numberToIndianWords', () => {
  const cases: [string, string][] = [
    ['0.00', 'Zero Rupees Only'],
    ['1.00', 'One Rupees Only'],
    ['15.00', 'Fifteen Rupees Only'],
    ['20.00', 'Twenty Rupees Only'],
    ['99.00', 'Ninety Nine Rupees Only'],
    ['100.00', 'One Hundred Rupees Only'],
    ['1000.00', 'One Thousand Rupees Only'],
    ['100000.00', 'One Lakh Rupees Only'],
    ['10000000.00', 'One Crore Rupees Only'],
    [
      '123456.78',
      'One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Seventy Eight Paise Only',
    ],
    [
      '12345678.90',
      'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees and Ninety Paise Only',
    ],
    ['0.05', 'Zero Rupees and Five Paise Only'],
  ];

  it.each(cases)('%s → %s', (amount, words) => {
    expect(numberToIndianWords(amount)).toBe(words);
  });

  it('recurses past 99 crore', () => {
    expect(numberToIndianWords('12000000000.00')).toBe('One Thousand Two Hundred Crore Rupees Only');
  });

  it('handles the widest amount the schema allows without float error', () => {
    expect(numberToIndianWords('9999999999999999.99')).toContain('Crore');
  });
});

describe('formatIndianNumber', () => {
  it('groups the Indian way', () => {
    expect(formatIndianNumber('12345678.9')).toBe('1,23,45,678.90');
    expect(formatIndianNumber('999.5')).toBe('999.50');
    expect(formatIndianNumber('1000')).toBe('1,000.00');
    expect(formatIndianNumber('100000')).toBe('1,00,000.00');
  });

  it('keeps the sign outside the symbol', () => {
    expect(formatMoney('-1234.5')).toBe('-₹1,234.50');
    expect(formatMoney('1234.5')).toBe('₹1,234.50');
  });
});

describe('fiscalYear', () => {
  it('turns over on 1 April, IST', () => {
    expect(fiscalYear('2025-04-01T00:00:00+05:30')).toBe('2025-26');
    expect(fiscalYear('2025-03-31T23:59:59+05:30')).toBe('2024-25');
  });

  it('uses IST, not UTC, for the boundary', () => {
    // 31 Mar 19:00 UTC is 1 Apr 00:30 IST — the new fiscal year
    expect(fiscalYear('2025-03-31T19:00:00Z')).toBe('2025-26');
  });

  it('round-trips through fiscalYearRange', () => {
    const { start, end } = fiscalYearRange('2025-26');
    expect(fiscalYear(start)).toBe('2025-26');
    expect(fiscalYear(new Date(end.getTime() - 1))).toBe('2025-26');
    expect(fiscalYear(end)).toBe('2026-27');
  });
});
