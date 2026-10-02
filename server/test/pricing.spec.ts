import { describe, expect, it } from 'vitest';
import { sum } from '../src/lib/money.js';
import { priceLine, recomputeTotals } from '../src/modules/quotation/pricing.js';

/**
 * `pricing.ts` is a pure function, so this file touches neither Postgres nor
 * Express. That is the whole reason it was written as one: the arithmetic every
 * downstream document depends on is checked in milliseconds.
 */

const line = (tenderItemId: string, taxRatePercent: string) => ({ tenderItemId, taxRatePercent });

describe('one line', () => {
  /** Plan 08 §10 — the figure verified by hand once, so it is verified forever. */
  it('prices the worked example from the plan', () => {
    const priced = priceLine(
      { tenderItemId: 'a', quantity: '12.000', unitPrice: '58500.00', discountPercent: '2.00' },
      '18.00',
    );

    expect(priced.grossAmount.toFixed(2)).toBe('702000.00');
    expect(priced.discountAmount.toFixed(2)).toBe('14040.00');
    expect(priced.taxableValue.toFixed(2)).toBe('687960.00');
    expect(priced.taxAmount.toFixed(2)).toBe('123832.80');
    expect(priced.lineTotal.toFixed(2)).toBe('811792.80');
  });

  it('defaults the discount to zero', () => {
    const priced = priceLine({ tenderItemId: 'a', quantity: '2.000', unitPrice: '100.00' }, '18.00');

    expect(priced.discountAmount.toFixed(2)).toBe('0.00');
    expect(priced.taxableValue.toFixed(2)).toBe('200.00');
    expect(priced.lineTotal.toFixed(2)).toBe('236.00');
  });

  it('rounds half up, not half to even', () => {
    // 1.00 × 12.5% = 0.125 exactly. Banker's rounding would give 0.12.
    const priced = priceLine(
      { tenderItemId: 'a', quantity: '1.000', unitPrice: '1.00', discountPercent: '12.50' },
      '0.00',
    );

    expect(priced.discountAmount.toFixed(2)).toBe('0.13');
    expect(priced.taxableValue.toFixed(2)).toBe('0.87');
  });

  it('handles a zero tax rate and a fractional quantity', () => {
    const priced = priceLine(
      { tenderItemId: 'a', quantity: '2.500', unitPrice: '40.00' },
      '0.00',
    );

    expect(priced.taxableValue.toFixed(2)).toBe('100.00');
    expect(priced.taxAmount.toFixed(2)).toBe('0.00');
    expect(priced.lineTotal.toFixed(2)).toBe('100.00');
  });
});

describe('the whole document', () => {
  it('takes the tax rate from the tender, not from the vendor', () => {
    const priced = recomputeTotals(
      [{ tenderItemId: 'a', quantity: '1.000', unitPrice: '100.00' }],
      [line('a', '5.00')],
    );

    expect(priced.taxAmount.toFixed(2)).toBe('5.00');
    expect(priced.grandTotal.toFixed(2)).toBe('105.00');
  });

  it('adds freight to the grand total untaxed', () => {
    const priced = recomputeTotals(
      [{ tenderItemId: 'a', quantity: '1.000', unitPrice: '1000.00' }],
      [line('a', '18.00')],
      '4500.00',
    );

    expect(priced.taxableAmount.toFixed(2)).toBe('1000.00');
    expect(priced.taxAmount.toFixed(2)).toBe('180.00');
    expect(priced.freightAmount.toFixed(2)).toBe('4500.00');
    expect(priced.grandTotal.toFixed(2)).toBe('5680.00');
  });

  /**
   * The rule that costs rupees when it is broken: **round each line, then sum.**
   * Twenty lines of 10.01 at 18% give 1.8018 tax each. Rounded per line and
   * summed that is 36.00; summed first and rounded once it is 36.04. The second
   * number is wrong — the stored line totals would not add up to the stored
   * grand total, and the PO in plan 10 would disagree with the bid it came from.
   */
  it('rounds each line before summing, on a twenty-line document', () => {
    const items = Array.from({ length: 20 }, (_item, index) => ({
      tenderItemId: `item-${index}`,
      quantity: '1.000',
      unitPrice: '10.01',
    }));
    const tenderLines = items.map((item) => line(item.tenderItemId, '18.00'));

    const priced = recomputeTotals(items, tenderLines);

    expect(priced.lines).toHaveLength(20);
    expect(priced.lines[0]!.taxAmount.toFixed(2)).toBe('1.80');
    expect(priced.subtotal.toFixed(2)).toBe('200.20');
    expect(priced.taxableAmount.toFixed(2)).toBe('200.20');
    expect(priced.taxAmount.toFixed(2)).toBe('36.00'); // not 36.04
    expect(priced.grandTotal.toFixed(2)).toBe('236.20'); // not 236.24

    // The document's own figures reconcile: the lines add up to the total.
    const lineSum = sum(priced.lines.map((l) => l.lineTotal));
    expect(lineSum.toFixed(2)).toBe(priced.grandTotal.toFixed(2));
  });

  it('sums discounts across mixed lines', () => {
    const priced = recomputeTotals(
      [
        { tenderItemId: 'a', quantity: '12.000', unitPrice: '58500.00', discountPercent: '2.00' },
        { tenderItemId: 'b', quantity: '24.000', unitPrice: '8200.00' },
      ],
      [line('a', '18.00'), line('b', '18.00')],
      '4500.00',
    );

    expect(priced.subtotal.toFixed(2)).toBe('898800.00'); // 702000 + 196800
    expect(priced.discountAmount.toFixed(2)).toBe('14040.00');
    expect(priced.taxableAmount.toFixed(2)).toBe('884760.00');
    expect(priced.taxAmount.toFixed(2)).toBe('159256.80'); // 123832.80 + 35424.00
    expect(priced.grandTotal.toFixed(2)).toBe('1048516.80');
  });

  it('refuses to price a line that is not on the tender', () => {
    expect(() =>
      recomputeTotals([{ tenderItemId: 'ghost', quantity: '1.000', unitPrice: '1.00' }], [line('a', '18.00')]),
    ).toThrow(/ghost/);
  });
});
