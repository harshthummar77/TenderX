import { describe, expect, it } from 'vitest';
import { round2 } from '../src/lib/money.js';
import { computeLineTax } from '../src/lib/tax.js';
import {
  hasNonOverridableFailure,
  runMatch,
  type MatchInput,
  type MatchInvoiceLine,
  type MatchPoLine,
} from '../src/modules/invoice/match.engine.js';

/**
 * The match engine is pure, so this file touches neither Postgres nor Express.
 * Written before any HTTP code, per plan 12 §11 — the engine is the module, and
 * everything else is plumbing around it.
 */

const VENDOR = 'vendor-1';

const poLine = (overrides: Partial<MatchPoLine> = {}): MatchPoLine => ({
  id: 'po-line-1',
  srNo: 1,
  unitPrice: '58500.00',
  taxRatePercent: '18.00',
  acceptedQuantity: '7.000',
  invoicedQuantity: '0.000',
  ...overrides,
});

/** An invoice line that is correct by construction, under INTRA_STATE. */
const invoiceLine = (overrides: Partial<MatchInvoiceLine> = {}): MatchInvoiceLine => {
  const quantity = overrides.quantity ?? '7.000';
  const unitPrice = overrides.unitPrice ?? '58500.00';
  const taxRatePercent = overrides.taxRatePercent ?? '18.00';
  const taxableValue = overrides.taxableValue ?? round2(round2(String(unitPrice)).mul(quantity)).toFixed(2);
  const tax = computeLineTax(taxableValue, taxRatePercent, 'INTRA_STATE');

  return {
    srNo: 1,
    purchaseOrderItemId: 'po-line-1',
    quantity,
    unitPrice,
    discountPercent: '0.00',
    taxRatePercent,
    taxableValue,
    cgstAmount: tax.cgstAmount.toFixed(2),
    sgstAmount: tax.sgstAmount.toFixed(2),
    igstAmount: tax.igstAmount.toFixed(2),
    ...overrides,
  };
};

/** Totals that reconcile with the given lines, so check 7 passes by default. */
const totalFor = (lines: MatchInvoiceLine[]): string => {
  const taxable = lines.reduce((sum, line) => sum.plus(round2(String(line.taxableValue))), round2(0));
  const tax = lines.reduce(
    (sum, line) =>
      sum
        .plus(round2(String(line.cgstAmount)))
        .plus(round2(String(line.sgstAmount)))
        .plus(round2(String(line.igstAmount))),
    round2(0),
  );
  return taxable.plus(tax).toDecimalPlaces(0).toFixed(2);
};

const input = (overrides: Partial<MatchInput> = {}): MatchInput => {
  const items = overrides.invoice?.items ?? [invoiceLine()];
  return {
    invoice: {
      vendorId: VENDOR,
      totalAmount: totalFor(items),
      items,
      ...overrides.invoice,
    },
    po: {
      status: 'ACCEPTED',
      vendorId: VENDOR,
      taxRegime: 'INTRA_STATE',
      items: [poLine()],
      ...overrides.po,
    },
    tolerancePercent: overrides.tolerancePercent ?? '2',
    duplicateExists: overrides.duplicateExists ?? false,
    requireGrn: overrides.requireGrn ?? false,
    grnCount: overrides.grnCount ?? 1,
  };
};

const check = (result: ReturnType<typeof runMatch>, code: string) =>
  result.checks.find((c) => c.code === code)!;

describe('a clean invoice', () => {
  /** Plan 12 §12 — the accepted quantity at the order price. */
  it('matches with every check passing', () => {
    const result = runMatch(input());

    expect(result.status).toBe('MATCHED');
    for (const c of result.checks) {
      expect(c.status, `${c.code}: ${c.label}`).toBe('PASS');
    }
  });

  it('passes the quantity check at exactly the accepted quantity', () => {
    const result = runMatch(input());
    expect(check(result, 'quantity').status).toBe('PASS');
  });
});

describe('quantity', () => {
  /** Plan 12 §12 — 12 invoiced against 7 accepted. */
  it('fails with the expected, actual and variance spelled out', () => {
    const items = [invoiceLine({ quantity: '12.000' })];
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items } }));

    expect(result.status).toBe('EXCEPTION');
    const quantity = check(result, 'quantity');
    expect(quantity.status).toBe('FAIL');
    expect(quantity.expected).toBe('7.000');
    expect(quantity.actual).toBe('12.000');
    expect(quantity.variance).toBe('5.000');
  });

  /** Cumulative, never per document — the same rule as deliveries and receipts. */
  it('counts what has already been invoiced', () => {
    const result = runMatch(
      input({ po: { status: 'ACCEPTED', vendorId: VENDOR, taxRegime: 'INTRA_STATE', items: [poLine({ invoicedQuantity: '5.000' })] } }),
    );

    // 7 accepted, 5 already invoiced, so only 2 remain and this bills 7.
    const quantity = check(result, 'quantity');
    expect(quantity.status).toBe('FAIL');
    expect(quantity.expected).toBe('2.000');
  });

  /**
   * A rematch re-runs against a line whose `invoicedQuantity` already includes
   * this invoice. Without adding it back, the invoice fails against itself.
   */
  it('does not fail an invoice against its own already-counted quantity', () => {
    const items = [invoiceLine({ previouslyInvoiced: '7.000' })];
    const result = runMatch(
      input({
        invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items },
        po: { status: 'ACCEPTED', vendorId: VENDOR, taxRegime: 'INTRA_STATE', items: [poLine({ invoicedQuantity: '7.000' })] },
      }),
    );

    expect(check(result, 'quantity').status).toBe('PASS');
  });

  it('is never tolerated, however small the overage', () => {
    const items = [invoiceLine({ quantity: '7.001' })];
    const result = runMatch(
      input({
        invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items },
        tolerancePercent: '50',
      }),
    );

    expect(check(result, 'quantity').status).toBe('FAIL');
    expect(result.status).toBe('EXCEPTION');
  });

  it('passes when nothing has been accepted and nothing is billed', () => {
    const items = [invoiceLine({ quantity: '0.000', taxableValue: '0.00' })];
    const result = runMatch(
      input({
        invoice: { vendorId: VENDOR, totalAmount: '0.00', items },
        po: { status: 'ACCEPTED', vendorId: VENDOR, taxRegime: 'INTRA_STATE', items: [poLine({ acceptedQuantity: '0.000' })] },
      }),
    );

    expect(check(result, 'quantity').status).toBe('PASS');
  });
});

describe('price tolerance', () => {
  /** Plan 12 §12 — 1.5% over with a 2% tolerance warns but still matches. */
  it('warns inside the tolerance and stays MATCHED overall', () => {
    const items = [invoiceLine({ unitPrice: '59377.50' })]; // +1.5%
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items } }));

    const price = check(result, 'price');
    expect(price.status).toBe('WARN');
    expect(price.variance).toBe('1.50%');
    expect(result.status).toBe('MATCHED');
  });

  /** Plan 12 §12 — 3% over fails. */
  it('fails beyond the tolerance', () => {
    const items = [invoiceLine({ unitPrice: '60255.00' })]; // +3%
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items } }));

    const price = check(result, 'price');
    expect(price.status).toBe('FAIL');
    expect(price.variance).toBe('3.00%');
    expect(result.status).toBe('EXCEPTION');
  });

  it('treats the tolerance boundary as acceptable', () => {
    const items = [invoiceLine({ unitPrice: '59670.00' })]; // exactly +2%
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items } }));

    expect(check(result, 'price').status).toBe('WARN');
    expect(result.status).toBe('MATCHED');
  });

  it('tolerates an undercharge the same way', () => {
    const items = [invoiceLine({ unitPrice: '57915.00' })]; // -1%
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items } }));

    expect(check(result, 'price').status).toBe('WARN');
  });

  it('fails a charge against a zero-priced line rather than dividing by zero', () => {
    const result = runMatch(
      input({ po: { status: 'ACCEPTED', vendorId: VENDOR, taxRegime: 'INTRA_STATE', items: [poLine({ unitPrice: '0.00' })] } }),
    );

    expect(check(result, 'price').status).toBe('FAIL');
  });
});

describe('tax', () => {
  it('fails a rate that is not the order rate', () => {
    const items = [invoiceLine({ taxRatePercent: '28.00' })];
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items } }));

    const rate = check(result, 'tax_rate');
    expect(rate.status).toBe('FAIL');
    expect(rate.expected).toBe('18.00%');
    expect(rate.actual).toBe('28.00%');
  });

  /**
   * The regime is frozen on the order. Charging IGST on an intra-state supply is
   * the right total under the wrong heads, and still an unusable tax document.
   */
  it('fails the right total charged under the wrong heads', () => {
    const correct = invoiceLine();
    const swapped: MatchInvoiceLine = {
      ...correct,
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: round2(correct.cgstAmount as string).plus(correct.sgstAmount as string).toFixed(2),
    };
    const result = runMatch(
      input({ invoice: { vendorId: VENDOR, totalAmount: totalFor([swapped]), items: [swapped] } }),
    );

    expect(check(result, 'tax_amount').status).toBe('FAIL');
    expect(result.status).toBe('EXCEPTION');
  });

  it('accepts IGST when the order itself is inter-state', () => {
    const taxable = '409500.00';
    const tax = computeLineTax(taxable, '18.00', 'INTER_STATE');
    const line = invoiceLine({
      taxableValue: taxable,
      cgstAmount: tax.cgstAmount.toFixed(2),
      sgstAmount: tax.sgstAmount.toFixed(2),
      igstAmount: tax.igstAmount.toFixed(2),
    });

    const result = runMatch(
      input({
        invoice: { vendorId: VENDOR, totalAmount: totalFor([line]), items: [line] },
        po: { status: 'ACCEPTED', vendorId: VENDOR, taxRegime: 'INTER_STATE', items: [poLine()] },
      }),
    );

    expect(check(result, 'tax_amount').status).toBe('PASS');
    expect(result.status).toBe('MATCHED');
  });
});

describe('structural checks', () => {
  it('fails an order that is not accepted', () => {
    const result = runMatch(
      input({ po: { status: 'CANCELLED', vendorId: VENDOR, taxRegime: 'INTRA_STATE', items: [poLine()] } }),
    );

    const poCheck = check(result, 'po_accepted');
    expect(poCheck.status).toBe('FAIL');
    expect(poCheck.actual).toBe('CANCELLED');
  });

  it('fails an invoice from a different vendor', () => {
    const result = runMatch(
      input({ po: { status: 'ACCEPTED', vendorId: 'someone-else', taxRegime: 'INTRA_STATE', items: [poLine()] } }),
    );

    expect(check(result, 'vendor_match').status).toBe('FAIL');
  });

  it('fails a line that is not on the order, and checks nothing else about it', () => {
    const items = [invoiceLine({ purchaseOrderItemId: 'ghost-line' })];
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items } }));

    expect(check(result, 'line_mapping').status).toBe('FAIL');
    // No quantity or price verdict is invented for a line with nothing to compare.
    expect(result.checks.find((c) => c.code === 'quantity')).toBeUndefined();
    expect(result.checks.find((c) => c.code === 'price')).toBeUndefined();
  });

  it('fails a total that does not equal the sum of its lines', () => {
    const items = [invoiceLine()];
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: '1.00', items } }));

    const total = check(result, 'total_arithmetic');
    expect(total.status).toBe('FAIL');
    expect(total.actual).toBe('1.00');
  });

  it('absorbs whole-rupee rounding in the total', () => {
    const items = [invoiceLine()];
    const exact = totalFor(items);
    const offByOne = round2(exact).minus(1).toFixed(2);
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: offByOne, items } }));

    expect(check(result, 'total_arithmetic').status).toBe('PASS');
  });

  /** Paying the same invoice twice is the most common AP fraud. */
  it('fails a duplicate invoice number', () => {
    const result = runMatch(input({ duplicateExists: true }));

    expect(check(result, 'duplicate').status).toBe('FAIL');
    expect(result.status).toBe('EXCEPTION');
  });

  it('only checks for a GRN when the organization requires one', () => {
    const without = runMatch(input({ requireGrn: false, grnCount: 0 }));
    expect(without.checks.find((c) => c.code === 'grn_exists')).toBeUndefined();
    expect(without.status).toBe('MATCHED');

    const required = runMatch(input({ requireGrn: true, grnCount: 0 }));
    expect(check(required, 'grn_exists').status).toBe('FAIL');
    expect(required.status).toBe('EXCEPTION');

    const satisfied = runMatch(input({ requireGrn: true, grnCount: 2 }));
    expect(check(satisfied, 'grn_exists').status).toBe('PASS');
  });
});

describe('multi-line documents', () => {
  it('reports a verdict per line and fails the whole document on one bad line', () => {
    const good = invoiceLine();
    const bad = invoiceLine({ srNo: 2, purchaseOrderItemId: 'po-line-2', quantity: '99.000' });
    const items = [good, bad];

    const result = runMatch(
      input({
        invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items },
        po: {
          status: 'ACCEPTED',
          vendorId: VENDOR,
          taxRegime: 'INTRA_STATE',
          items: [poLine(), poLine({ id: 'po-line-2', srNo: 2, acceptedQuantity: '4.000' })],
        },
      }),
    );

    const quantityChecks = result.checks.filter((c) => c.code === 'quantity');
    expect(quantityChecks).toHaveLength(2);
    expect(quantityChecks[0]!.status).toBe('PASS');
    expect(quantityChecks[1]!.status).toBe('FAIL');
    expect(result.status).toBe('EXCEPTION');
  });
});

describe('override eligibility', () => {
  /** Price and rounding may be waved through; goods never received may not. */
  it('lets a price exception be overridden', () => {
    const items = [invoiceLine({ unitPrice: '60255.00' })];
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items } }));

    expect(hasNonOverridableFailure(result.checks)).toBeUndefined();
  });

  it('refuses to let a quantity exception be overridden', () => {
    const items = [invoiceLine({ quantity: '12.000' })];
    const result = runMatch(input({ invoice: { vendorId: VENDOR, totalAmount: totalFor(items), items } }));

    expect(hasNonOverridableFailure(result.checks)?.code).toBe('quantity');
  });

  it('refuses to let a duplicate be overridden', () => {
    const result = runMatch(input({ duplicateExists: true }));
    expect(hasNonOverridableFailure(result.checks)?.code).toBe('duplicate');
  });
});
