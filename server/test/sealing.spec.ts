import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/lib/canonicalJson.js';
import { computeSealHash, isSealed } from '../src/modules/quotation/sealing.js';

/**
 * The seal has one job: the same bid must hash the same way every time, and a
 * changed bid must not. Both halves are tested here without a database, because
 * both are pure.
 */

const submittedAt = new Date('2025-09-18T11:04:00.000Z');

const seal = (overrides: Record<string, unknown> = {}) =>
  computeSealHash({
    tenderId: 'aaaaaaaa-0000-4000-8000-000000000001',
    vendorId: 'bbbbbbbb-0000-4000-8000-000000000002',
    submittedAt,
    grandTotal: '811792.80',
    items: [
      { tenderItemId: 'item-a', quantity: '12.000', unitPrice: '58500.00' },
      { tenderItemId: 'item-b', quantity: '24.000', unitPrice: '8200.00' },
    ],
    ...overrides,
  } as Parameters<typeof computeSealHash>[0]);

describe('canonicalJson', () => {
  it('does not depend on the order the keys were typed in', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalJson({ x: { p: 1, q: 2 } })).toBe(canonicalJson({ x: { q: 2, p: 1 } }));
  });

  it('treats an absent key and an undefined one as the same thing', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('keeps array order — the caller sorts, not the encoder', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('computeSealHash', () => {
  it('is stable across calls', () => {
    expect(seal()).toBe(seal());
  });

  it('does not depend on the order Postgres returned the rows in', () => {
    expect(
      seal({
        items: [
          { tenderItemId: 'item-b', quantity: '24.000', unitPrice: '8200.00' },
          { tenderItemId: 'item-a', quantity: '12.000', unitPrice: '58500.00' },
        ],
      }),
    ).toBe(seal());
  });

  /**
   * decimal.js drops trailing zeros, so a quantity read back from Postgres as
   * `12.000` stringifies to `12`. Hashing the raw string would report tampering
   * on a bid nobody touched — the fixed-width formatters are what prevent it.
   */
  it('normalises decimal widths', () => {
    expect(
      seal({
        items: [
          { tenderItemId: 'item-a', quantity: '12', unitPrice: '58500' },
          { tenderItemId: 'item-b', quantity: '24.0', unitPrice: '8200.000' },
        ],
      }),
    ).toBe(seal());
  });

  it('changes when a unit price changes', () => {
    expect(
      seal({
        items: [
          { tenderItemId: 'item-a', quantity: '12.000', unitPrice: '58499.00' },
          { tenderItemId: 'item-b', quantity: '24.000', unitPrice: '8200.00' },
        ],
      }),
    ).not.toBe(seal());
  });

  it('changes when the grand total changes', () => {
    expect(seal({ grandTotal: '811792.81' })).not.toBe(seal());
  });

  it('changes when the submission timestamp changes', () => {
    expect(seal({ submittedAt: new Date('2025-09-18T11:04:01.000Z') })).not.toBe(seal());
  });

  it('is a sha256 hex digest, and reveals nothing about the amount', () => {
    const hash = seal();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('811792');
  });
});

describe('isSealed', () => {
  const now = new Date('2025-09-20T18:00:00.000Z');

  it('is sealed while bidOpenedAt is unset', () => {
    expect(isSealed({ bidOpenedAt: null }, now)).toBe(true);
  });

  it('is sealed while bidOpenedAt is still in the future', () => {
    expect(isSealed({ bidOpenedAt: new Date('2025-09-20T18:00:01.000Z') }, now)).toBe(true);
  });

  it('is open once bidOpenedAt has passed', () => {
    expect(isSealed({ bidOpenedAt: new Date('2025-09-20T17:59:59.000Z') }, now)).toBe(false);
  });
});
