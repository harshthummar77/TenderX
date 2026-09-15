import { describe, expect, it } from 'vitest';
import {
  gstinChecksum,
  gstinMatchesPan,
  maskAccount,
  validateGstin,
  validateIfsc,
  validatePan,
} from '@tb/shared';

/**
 * Pure unit tests — no database, no HTTP. The checksum is the one piece of this
 * module that is genuinely arithmetic, so it is tested exhaustively: every
 * single-character mutation of a valid GSTIN must be rejected.
 */

/** Structurally valid GSTINs with correct check digits, one per common state. */
const VALID = [
  '27AAPFU0939F1ZV',
  '24AABCM1234F1Z3',
  '07AAACH7409R1Z3',
  '29AAACW1234B1ZS',
  '33AAACT2727Q1Z3',
  '19AAACI1681G1ZM',
];

const INVALID: [string, string][] = [
  ['27AAPFU0939F1Z', 'too short'],
  ['27AAPFU0939F1ZVV', 'too long'],
  ['2AAPFU0939F11ZV', 'state code not two digits'],
  ['99AAPFU0939F1ZW', 'unknown state code'],
  ['27AAPFU0939F1AV', '14th character is not Z'],
  ['27AAPFU0939F1ZA', 'wrong check digit'],
];

describe('validateGstin', () => {
  it.each(VALID)('accepts %s', (gstin) => {
    const result = validateGstin(gstin);
    expect(result.valid, result.message).toBe(true);
    expect(result.stateCode).toBe(gstin.slice(0, 2));
    expect(result.pan).toBe(gstin.slice(2, 12));
  });

  it.each(INVALID)('rejects %s (%s)', (gstin) => {
    expect(validateGstin(gstin).valid).toBe(false);
  });

  it('rejects every single-character mutation of a valid GSTIN', () => {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const base = '27AAPFU0939F1ZV';
    let mutations = 0;
    const accepted: string[] = [];

    for (let position = 0; position < base.length; position++) {
      for (const character of alphabet) {
        if (character === base[position]) continue;
        const mutated = base.slice(0, position) + character + base.slice(position + 1);
        mutations += 1;
        if (validateGstin(mutated).valid) accepted.push(mutated);
      }
    }

    expect(mutations).toBe(15 * 35);
    expect(accepted).toEqual([]);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(validateGstin('  27aapfu0939f1zv ').valid).toBe(true);
  });

  it('computes the check digit independently', () => {
    for (const gstin of VALID) {
      expect(gstinChecksum(gstin.slice(0, 14))).toBe(gstin[14]);
    }
  });
});

describe('PAN, IFSC and GSTIN/PAN agreement', () => {
  it.each(['AAPFU0939F', 'AABCM1234F', 'ABCDE1234A'])('accepts PAN %s', (pan) => {
    expect(validatePan(pan)).toBe(true);
  });

  it.each(['AAPFU0939', 'AAPFU09391', '1APFU0939F', 'AAPFU0939FF'])('rejects PAN %s', (pan) => {
    expect(validatePan(pan)).toBe(false);
  });

  it('matches the PAN embedded in a GSTIN', () => {
    expect(gstinMatchesPan('27AAPFU0939F1ZV', 'AAPFU0939F')).toBe(true);
    expect(gstinMatchesPan('27AAPFU0939F1ZV', 'AABCM1234F')).toBe(false);
  });

  it.each(['HDFC0001234', 'SBIN0000456', 'ICIC0ABC123'])('accepts IFSC %s', (ifsc) => {
    expect(validateIfsc(ifsc)).toBe(true);
  });

  it.each(['HDFC1001234', 'HDF00001234', 'HDFC000123', 'hdfc0001234X'])(
    'rejects IFSC %s',
    (ifsc) => {
      expect(validateIfsc(ifsc)).toBe(false);
    },
  );
});

describe('maskAccount', () => {
  /**
   * Length-preserving: one X per hidden digit. Plan 06 §3 writes the example as
   * `maskAccount('123456784821') === 'XXXXXX4821'`, which is a 10-character mask
   * for a 12-digit account — the example, not the rule. Preserving length keeps
   * "is this the 11-digit or the 14-digit account?" answerable on screen without
   * revealing a single extra digit.
   */
  it('keeps only the last four digits', () => {
    expect(maskAccount('123456784821')).toBe('XXXXXXXX4821');
    expect(maskAccount('50100123456789')).toBe('XXXXXXXXXX6789');
    expect(maskAccount('123456784821')).toMatch(/^X+4821$/);
  });

  it('never returns more than it was given', () => {
    expect(maskAccount('4821')).toBe('XXXX');
    expect(maskAccount('')).toBe(null);
    expect(maskAccount(null)).toBe(null);
    expect(maskAccount(undefined)).toBe(null);
  });
});
