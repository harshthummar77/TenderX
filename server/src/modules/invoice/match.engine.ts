import type { MatchStatus, TaxRegime } from '@tb/shared';
import { money, qtyToApi, round2, toApi, ZERO, type Decimal } from '../../lib/money.js';
import { computeLineTax, sumPoTotals, type TaxedLine } from '../../lib/tax.js';

/**
 * The three-way match engine (plan 12 §6). **Pure**: no Prisma, no `req`, no
 * clock. It takes data and returns a verdict, which is why `match.spec.ts` can
 * prove every branch without a database and why the seed script can reuse it.
 *
 * The engine stores its *reasoning*, not just its verdict. A stored checklist is
 * what lets an officer act on an exception; the single word "FAILED" leaves them
 * staring at a screen with nothing to do.
 *
 * **Tolerance applies to price and totals only — never to quantity.** There is
 * no such thing as "approximately how many arrived", and the whole chain that
 * makes "payment only after delivery" true runs through the quantity check:
 * it reads `acceptedQuantity`, which only a confirmed GRN ever writes.
 */

export interface MatchCheck {
  /** Stable code the UI and the override guard both key on. */
  code: string;
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  expected?: string;
  actual?: string;
  variance?: string;
  detail?: string;
}

export interface MatchPoLine {
  id: string;
  srNo: number;
  unitPrice: Decimal.Value;
  taxRatePercent: Decimal.Value;
  acceptedQuantity: Decimal.Value;
  invoicedQuantity: Decimal.Value;
}

export interface MatchInvoiceLine {
  srNo: number;
  purchaseOrderItemId: string;
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  discountPercent: Decimal.Value;
  taxRatePercent: Decimal.Value;
  taxableValue: Decimal.Value;
  cgstAmount: Decimal.Value;
  sgstAmount: Decimal.Value;
  igstAmount: Decimal.Value;
  /**
   * What *this* invoice already contributed to `invoicedQuantity`.
   *
   * Zero on first submission. On a rematch the line's quantity is already
   * counted, so without adding it back the invoice would fail the quantity check
   * against itself.
   */
  previouslyInvoiced?: Decimal.Value;
}

export interface MatchInput {
  invoice: {
    vendorId: string;
    totalAmount: Decimal.Value;
    freightAmount?: Decimal.Value;
    items: MatchInvoiceLine[];
  };
  po: {
    status: string;
    vendorId: string;
    taxRegime: TaxRegime;
    items: MatchPoLine[];
  };
  tolerancePercent: Decimal.Value;
  duplicateExists: boolean;
  requireGrn: boolean;
  grnCount: number;
}

const pass = (code: string, label: string, detail?: string): MatchCheck => ({
  code,
  label,
  status: 'PASS',
  ...(detail ? { detail } : {}),
});

const warn = (
  code: string,
  label: string,
  expected?: string,
  actual?: string,
  variance?: string,
): MatchCheck => ({ code, label, status: 'WARN', expected, actual, variance });

const fail = (
  code: string,
  label: string,
  expected?: string,
  actual?: string,
  variance?: string,
): MatchCheck => ({ code, label, status: 'FAIL', expected, actual, variance });

/**
 * Invoice totals use the same engine as the purchase order (plan 10 §3) — one
 * tax implementation, deliberately. Two would drift, and the three-way match
 * would then be comparing two different notions of correct.
 */
export const sumInvoiceTotals = sumPoTotals;

/** Codes that an admin override may clear. Quantity is deliberately absent. */
export const OVERRIDABLE_CODES = [
  'price',
  'total_arithmetic',
  'tax_amount',
  'tax_rate',
  'grn_exists',
] as const;

/** The one exception class that can never be waved through (plan 12 §7). */
export const NON_OVERRIDABLE_CODES = ['quantity', 'vendor_match', 'line_mapping', 'duplicate'] as const;

export function runMatch(input: MatchInput): { status: MatchStatus; checks: MatchCheck[] } {
  const checks: MatchCheck[] = [];
  const tolerance = money(input.tolerancePercent);

  // 1 — the order must still be a live contract.
  checks.push(
    input.po.status === 'ACCEPTED'
      ? pass('po_accepted', 'Purchase order is accepted')
      : fail('po_accepted', 'Purchase order is accepted', 'ACCEPTED', input.po.status),
  );

  // 2 — billing for somebody else's order.
  checks.push(
    input.invoice.vendorId === input.po.vendorId
      ? pass('vendor_match', 'Invoice vendor matches the purchase order')
      : fail('vendor_match', 'Invoice vendor matches the purchase order'),
  );

  for (const line of input.invoice.items) {
    const poItem = input.po.items.find((item) => item.id === line.purchaseOrderItemId);

    // 3 — a line that is not on the order cannot be checked against anything.
    if (!poItem) {
      checks.push(fail('line_mapping', `Line ${line.srNo} is not on the purchase order`));
      continue;
    }

    /*
     * 4 — quantity against goods actually *accepted*, cumulatively, with no
     * tolerance. This is the check the README's headline rule rests on.
     */
    const available = money(poItem.acceptedQuantity)
      .minus(money(poItem.invoicedQuantity))
      .plus(money(line.previouslyInvoiced ?? 0));

    checks.push(
      money(line.quantity).lessThanOrEqualTo(available)
        ? pass('quantity', `Line ${line.srNo}: quantity within goods received`)
        : fail(
            'quantity',
            `Line ${line.srNo}: quantity exceeds goods received`,
            qtyToApi(available),
            qtyToApi(line.quantity),
            qtyToApi(money(line.quantity).minus(available)),
          ),
    );

    // 5 — price against the order, tolerated within a margin.
    const poPrice = money(poItem.unitPrice);
    const invoicePrice = money(line.unitPrice);

    if (poPrice.isZero()) {
      checks.push(
        invoicePrice.isZero()
          ? pass('price', `Line ${line.srNo}: unit price matches`)
          : fail(
              'price',
              `Line ${line.srNo}: unit price charged against a zero-priced line`,
              toApi(poPrice),
              toApi(invoicePrice),
            ),
      );
    } else {
      const variance = invoicePrice.minus(poPrice).abs().div(poPrice).mul(100);
      checks.push(
        variance.isZero()
          ? pass('price', `Line ${line.srNo}: unit price matches`)
          : variance.lessThanOrEqualTo(tolerance)
            ? warn(
                'price',
                `Line ${line.srNo}: unit price within tolerance`,
                toApi(poPrice),
                toApi(invoicePrice),
                `${round2(variance).toFixed(2)}%`,
              )
            : fail(
                'price',
                `Line ${line.srNo}: unit price exceeds tolerance`,
                toApi(poPrice),
                toApi(invoicePrice),
                `${round2(variance).toFixed(2)}%`,
              ),
      );
    }

    // 6a — the tax rate is the buyer's, set on the order.
    checks.push(
      money(line.taxRatePercent).equals(money(poItem.taxRatePercent))
        ? pass('tax_rate', `Line ${line.srNo}: tax rate matches`)
        : fail(
            'tax_rate',
            `Line ${line.srNo}: tax rate differs`,
            `${money(poItem.taxRatePercent).toFixed(2)}%`,
            `${money(line.taxRatePercent).toFixed(2)}%`,
          ),
    );

    /*
     * 6b — and the tax actually charged must be what that rate produces under
     * the order's frozen regime. A correct rate with the wrong heads (IGST on an
     * intra-state supply) is still an unusable tax document.
     */
    const expectedTax = computeLineTax(line.taxableValue, line.taxRatePercent, input.po.taxRegime);
    const chargedTax = money(line.cgstAmount)
      .plus(money(line.sgstAmount))
      .plus(money(line.igstAmount));
    const expectedTotalTax = expectedTax.cgstAmount
      .plus(expectedTax.sgstAmount)
      .plus(expectedTax.igstAmount);

    const headsAgree =
      money(line.cgstAmount).equals(expectedTax.cgstAmount) &&
      money(line.sgstAmount).equals(expectedTax.sgstAmount) &&
      money(line.igstAmount).equals(expectedTax.igstAmount);

    checks.push(
      headsAgree
        ? pass('tax_amount', `Line ${line.srNo}: tax computed correctly`)
        : fail(
            'tax_amount',
            `Line ${line.srNo}: tax does not match the order's ${input.po.taxRegime} regime`,
            toApi(expectedTotalTax),
            toApi(chargedTax),
            toApi(chargedTax.minus(expectedTotalTax).abs()),
          ),
    );
  }

  /*
   * 7 — the document must add up to itself. A rupee of slack absorbs the
   * whole-rupee rounding the tax engine applies; anything larger is arithmetic
   * nobody can reconcile.
   */
  const computed = sumInvoiceTotals(
    input.invoice.items.map(
      (line): TaxedLine => ({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        taxableValue: line.taxableValue,
        cgstAmount: line.cgstAmount,
        sgstAmount: line.sgstAmount,
        igstAmount: line.igstAmount,
      }),
    ),
    input.invoice.freightAmount ?? ZERO,
  );

  checks.push(
    computed.totalAmount.minus(money(input.invoice.totalAmount)).abs().lessThanOrEqualTo(1)
      ? pass('total_arithmetic', 'Invoice total equals the sum of its lines')
      : fail(
          'total_arithmetic',
          'Invoice total does not equal the sum of its lines',
          toApi(computed.totalAmount),
          toApi(input.invoice.totalAmount),
        ),
  );

  /*
   * 8 — duplicate-invoice detection. Paying the same invoice twice is the single
   * most common accounts-payable fraud, and this is backed by the
   * `(vendorId, vendorInvoiceNumber)` unique index as well as this check.
   */
  checks.push(
    input.duplicateExists
      ? fail('duplicate', 'Duplicate invoice number for this vendor')
      : pass('duplicate', 'Invoice number is unique for this vendor'),
  );

  // 9 — goods must have been receipted at all, when the organization requires it.
  if (input.requireGrn) {
    checks.push(
      input.grnCount > 0
        ? pass('grn_exists', 'Goods received note exists')
        : fail('grn_exists', 'No goods received note for this purchase order'),
    );
  }

  return {
    status: checks.some((check) => check.status === 'FAIL') ? 'EXCEPTION' : 'MATCHED',
    checks,
  };
}

/** The failing checks, for a message that names what actually went wrong. */
export const failuresOf = (checks: MatchCheck[]): MatchCheck[] =>
  checks.filter((check) => check.status === 'FAIL');

/**
 * Whether an override may clear this exception set.
 *
 * Price and rounding, yes — a ₹40 difference on an ₹8 lakh order should not
 * stall a payment for a week. Claiming goods that were never received, no.
 */
export const hasNonOverridableFailure = (checks: MatchCheck[]): MatchCheck | undefined =>
  failuresOf(checks).find((check) =>
    (NON_OVERRIDABLE_CODES as readonly string[]).includes(check.code),
  );
