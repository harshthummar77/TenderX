import { describe, expect, it } from 'vitest';
import { money, round2, sum } from '../src/lib/money.js';
import {
  computeLineTax,
  regimeForSupply,
  resolveTaxRegime,
  sumPoTotals,
  taxHeadsFor,
  totalTaxOf,
  type TaxedLine,
} from '../src/lib/tax.js';

/**
 * The GST matrix from plan 10 §3, written before any purchase-order code. Every
 * rate the system can meet, crossed with every regime, plus the two properties
 * that make a document legally coherent: the lines add up to the total, and the
 * round-off stays inside half a rupee.
 */

const GST_RATES = ['0', '5', '12', '18', '28'] as const;

/** One priced line, taxed under `regime`. */
const line = (
  unitPrice: string,
  quantity: string,
  ratePercent: string,
  regime: Parameters<typeof computeLineTax>[2],
  discountPercent = '0',
): TaxedLine => {
  const gross = round2(money(unitPrice).mul(quantity));
  const discount = round2(gross.mul(discountPercent).div(100));
  const taxableValue = round2(gross.minus(discount));
  const tax = computeLineTax(taxableValue, ratePercent, regime);
  return { quantity, unitPrice, discountPercent, taxableValue, ...tax };
};

describe('resolveTaxRegime', () => {
  it('is intra-state when supplier and place of supply match', () => {
    expect(resolveTaxRegime('24', '24')).toBe('INTRA_STATE');
  });

  it('is inter-state when they differ', () => {
    expect(resolveTaxRegime('24', '27')).toBe('INTER_STATE');
  });

  it('is exempt when either side is unknown', () => {
    expect(resolveTaxRegime(null, '24')).toBe('EXEMPT');
    expect(resolveTaxRegime('24', null)).toBe('EXEMPT');
    expect(resolveTaxRegime('', '')).toBe('EXEMPT');
  });

  /** Rule 6 — a supplier with an address but no GSTIN still cannot charge GST. */
  it('treats a supplier with no GSTIN as exempt even inside the same state', () => {
    expect(regimeForSupply({ gstin: null, stateCode: '24' }, '24')).toBe('EXEMPT');
    expect(regimeForSupply({ gstin: '24AABCU9603R1ZM', stateCode: '24' }, '24')).toBe('INTRA_STATE');
    expect(regimeForSupply({ gstin: '24AABCU9603R1ZM', stateCode: '24' }, '27')).toBe('INTER_STATE');
  });
});

describe('computeLineTax', () => {
  /** Plan 10 §11 — Gujarat vendor, Gujarat delivery, ₹1,00,000 at 18%. */
  it('splits intra-state 18% into 9% CGST and 9% SGST', () => {
    const tax = computeLineTax('100000.00', '18', 'INTRA_STATE');

    expect(tax.cgstAmount.toFixed(2)).toBe('9000.00');
    expect(tax.sgstAmount.toFixed(2)).toBe('9000.00');
    expect(tax.igstAmount.toFixed(2)).toBe('0.00');
  });

  /** Plan 10 §11 — same values, Maharashtra delivery. */
  it('charges inter-state 18% entirely as IGST', () => {
    const tax = computeLineTax('100000.00', '18', 'INTER_STATE');

    expect(tax.igstAmount.toFixed(2)).toBe('18000.00');
    expect(tax.cgstAmount.toFixed(2)).toBe('0.00');
    expect(tax.sgstAmount.toFixed(2)).toBe('0.00');
  });

  it('charges nothing under EXEMPT, at any rate', () => {
    for (const rate of GST_RATES) {
      const tax = computeLineTax('100000.00', rate, 'EXEMPT');
      expect(totalTaxOf(tax).toFixed(2)).toBe('0.00');
    }
  });

  /**
   * The whole matrix: every rate the system meets, under every regime. Intra and
   * inter must always charge the same *total* — only the heads differ.
   */
  it.each(GST_RATES)('charges the same total intra and inter at %s%%', (rate) => {
    const intra = computeLineTax('100000.00', rate, 'INTRA_STATE');
    const inter = computeLineTax('100000.00', rate, 'INTER_STATE');

    const expected = round2(money('100000.00').mul(rate).div(100));
    expect(totalTaxOf(intra).toFixed(2)).toBe(expected.toFixed(2));
    expect(totalTaxOf(inter).toFixed(2)).toBe(expected.toFixed(2));

    // ...and exactly one set of heads is ever used.
    expect(intra.igstAmount.isZero()).toBe(true);
    expect(inter.cgstAmount.isZero()).toBe(true);
    expect(inter.sgstAmount.isZero()).toBe(true);
  });

  /** Rule 2, stated as a test so nobody "fixes" it into rate-twice. */
  it('halves the rate per head rather than applying it twice', () => {
    const tax = computeLineTax('1000.00', '28', 'INTRA_STATE');
    expect(tax.cgstAmount.toFixed(2)).toBe('140.00');
    expect(tax.sgstAmount.toFixed(2)).toBe('140.00');
    expect(totalTaxOf(tax).toFixed(2)).toBe('280.00');
  });

  it('keeps the two intra-state halves equal even on an odd paise split', () => {
    // 18% of 1000.05 is 180.009; each half is 90.0045 -> 90.00.
    const tax = computeLineTax('1000.05', '18', 'INTRA_STATE');
    expect(tax.cgstAmount.toFixed(2)).toBe(tax.sgstAmount.toFixed(2));
  });

  it('names the heads a document may print', () => {
    expect(taxHeadsFor('INTRA_STATE')).toEqual(['CGST', 'SGST']);
    expect(taxHeadsFor('INTER_STATE')).toEqual(['IGST']);
    expect(taxHeadsFor('EXEMPT')).toEqual([]);
  });
});

describe('sumPoTotals', () => {
  /** Plan 10 §11 — a mixed-rate document must reconcile exactly. */
  it('reconciles a three-line document at 5%, 12% and 18%', () => {
    const items = [
      line('1000.00', '10.000', '5', 'INTRA_STATE'),
      line('2500.00', '4.000', '12', 'INTRA_STATE'),
      line('58500.00', '12.000', '18', 'INTRA_STATE'),
    ];
    const totals = sumPoTotals(items, '4500.00');

    expect(totals.subtotal.toFixed(2)).toBe('722000.00'); // 10000 + 10000 + 702000
    expect(totals.taxableAmount.toFixed(2)).toBe('722000.00');

    // 5% of 10000 = 500, 12% of 10000 = 1200, 18% of 702000 = 126360.
    expect(totalTaxOf(totals).toFixed(2)).toBe('128060.00');
    expect(totals.cgstAmount.toFixed(2)).toBe('64030.00');
    expect(totals.sgstAmount.toFixed(2)).toBe('64030.00');

    // The printed line totals equal totalAmount - roundOff - freight.
    const lineTotals = sum(
      items.map((item) =>
        round2(
          money(item.taxableValue)
            .plus(money(item.cgstAmount))
            .plus(money(item.sgstAmount))
            .plus(money(item.igstAmount)),
        ),
      ),
    );
    expect(lineTotals.toFixed(2)).toBe(
      totals.totalAmount.minus(totals.roundOff).minus(totals.freightAmount).toFixed(2),
    );
  });

  it('carries a discount into the taxable value, not into the tax rate', () => {
    const items = [line('58500.00', '12.000', '18', 'INTRA_STATE', '2')];
    const totals = sumPoTotals(items);

    expect(totals.subtotal.toFixed(2)).toBe('702000.00');
    expect(totals.discountAmount.toFixed(2)).toBe('14040.00');
    expect(totals.taxableAmount.toFixed(2)).toBe('687960.00');
    // 18% of 687960 = 123832.80, split 61916.40 / 61916.40.
    expect(totalTaxOf(totals).toFixed(2)).toBe('123832.80');
  });

  it('adds freight to the total without taxing it', () => {
    const items = [line('1000.00', '1.000', '18', 'INTRA_STATE')];
    const withFreight = sumPoTotals(items, '500.00');
    const without = sumPoTotals(items, '0');

    expect(totalTaxOf(withFreight).toFixed(2)).toBe(totalTaxOf(without).toFixed(2));
    expect(withFreight.freightAmount.toFixed(2)).toBe('500.00');
  });

  it('rounds the total to whole rupees and books the difference to roundOff', () => {
    // 18% of 1000.55 -> taxable 1000.55, tax 180.10 (90.05 x 2), total 1180.65.
    const totals = sumPoTotals([line('1000.55', '1.000', '18', 'INTRA_STATE')]);

    expect(totals.totalAmount.toFixed(2)).toBe('1181.00');
    expect(totals.roundOff.toFixed(2)).toBe('0.35');

    // The identity that makes the document reconcile.
    const reconciled = totals.taxableAmount
      .plus(totalTaxOf(totals))
      .plus(totals.freightAmount)
      .plus(totals.roundOff);
    expect(reconciled.toFixed(2)).toBe(totals.totalAmount.toFixed(2));
  });

  it('is all zeros for an empty document', () => {
    const totals = sumPoTotals([]);
    expect(totals.totalAmount.toFixed(2)).toBe('0.00');
    expect(totals.roundOff.toFixed(2)).toBe('0.00');
  });

  /**
   * Plan 10 §11, as a property test: `roundOff` is bounded by half a rupee by
   * construction, for every document the engine can produce. Deterministic
   * pseudo-random input so a failure is reproducible rather than a once-a-month
   * mystery in CI.
   */
  it('keeps |roundOff| <= 0.50 across 100 generated documents', () => {
    let seed = 20_251_002;
    const next = () => {
      // Park–Miller: tiny, deterministic, good enough to shake out rounding.
      seed = (seed * 48_271) % 2_147_483_647;
      return seed / 2_147_483_647;
    };

    const regimes = ['INTRA_STATE', 'INTER_STATE', 'EXEMPT'] as const;

    for (let doc = 0; doc < 100; doc++) {
      const regime = regimes[Math.floor(next() * regimes.length)]!;
      const lineCount = 1 + Math.floor(next() * 8);

      const items = Array.from({ length: lineCount }, () =>
        line(
          (next() * 99_999 + 0.01).toFixed(2),
          (next() * 20 + 0.001).toFixed(3),
          GST_RATES[Math.floor(next() * GST_RATES.length)]!,
          regime,
          (next() * 10).toFixed(2),
        ),
      );

      const totals = sumPoTotals(items, (next() * 5000).toFixed(2));

      expect(totals.roundOff.abs().lessThanOrEqualTo('0.50'), `doc ${doc}`).toBe(true);
      // Whole rupees, every time.
      expect(totals.totalAmount.modulo(1).isZero(), `doc ${doc}`).toBe(true);
      // And the document still reconciles.
      const reconciled = totals.taxableAmount
        .plus(totalTaxOf(totals))
        .plus(totals.freightAmount)
        .plus(totals.roundOff);
      expect(reconciled.toFixed(2), `doc ${doc}`).toBe(totals.totalAmount.toFixed(2));
    }
  });
});
