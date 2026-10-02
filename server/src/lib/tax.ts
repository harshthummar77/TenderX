import type { TaxRegime } from '@tb/shared';
import { Decimal, money, round2, sum, ZERO } from './money.js';

/**
 * The Indian GST engine (10 §3). Pure functions, no Prisma — used by the
 * purchase order (plan 10), the invoice (plan 12) and the seed script, so it is
 * written once and tested hard.
 *
 * Six rules live here, and getting any of them wrong produces a document that
 * is arithmetically plausible and legally wrong:
 *
 * 1. **Round per line, then sum.** A GST document must have line amounts that
 *    add up to the printed total. Summing unrounded values and rounding once at
 *    the end produces a total that does not match its own lines.
 * 2. **CGST and SGST are each *half* the rate**, not the full rate twice.
 *    18% intra-state is 9% + 9%.
 * 3. **Place of supply decides the regime, not the buyer's address.** Gujarat
 *    goods delivered to a Maharashtra site are an inter-state supply even when
 *    the buyer is in Gujarat — which is exactly why `Tender.deliveryStateCode`
 *    exists as a field of its own.
 * 4. `roundOff` is the gap between the exact total and the whole-rupee total,
 *    printed as its own line. It is bounded by ±0.50 by construction.
 * 5. Mixed rates in one document are normal (5% freight, 18% goods). Nothing
 *    here assumes a single rate.
 * 6. A supplier with no GSTIN is `EXEMPT`: zero tax on every line.
 */

/**
 * Same state → CGST + SGST. Different states → IGST.
 *
 * An unregistered supplier (no GSTIN, hence no state code) is EXEMPT: they
 * cannot charge GST, so the document must not pretend they did.
 */
export function resolveTaxRegime(
  supplierStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined,
): TaxRegime {
  if (!supplierStateCode || !placeOfSupplyStateCode) return 'EXEMPT';
  return supplierStateCode === placeOfSupplyStateCode ? 'INTRA_STATE' : 'INTER_STATE';
}

/**
 * A supplier is only registered when they actually have a GSTIN. State code
 * alone is not enough — every party has an address, not every party is
 * registered.
 */
export function regimeForSupply(
  supplier: { gstin?: string | null; stateCode?: string | null },
  placeOfSupplyStateCode: string | null | undefined,
): TaxRegime {
  if (!supplier.gstin) return 'EXEMPT';
  return resolveTaxRegime(supplier.stateCode, placeOfSupplyStateCode);
}

export interface LineTax {
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
}

/** One line's tax, split by head. Exactly one head is ever non-zero. */
export function computeLineTax(
  taxableValue: Decimal.Value,
  ratePercent: Decimal.Value,
  regime: TaxRegime,
): LineTax {
  const taxable = money(taxableValue);
  const rate = money(ratePercent);

  if (regime === 'EXEMPT') {
    return { cgstAmount: ZERO, sgstAmount: ZERO, igstAmount: ZERO };
  }

  if (regime === 'INTRA_STATE') {
    // rate/2 to each head: div(200) is rate/100/2 in one step, so both halves
    // are rounded from the same exact value and always agree.
    const half = round2(taxable.mul(rate).div(200));
    return { cgstAmount: half, sgstAmount: half, igstAmount: ZERO };
  }

  return {
    cgstAmount: ZERO,
    sgstAmount: ZERO,
    igstAmount: round2(taxable.mul(rate).div(100)),
  };
}

/** A line that has already been priced and taxed. */
export interface TaxedLine {
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  discountPercent: Decimal.Value;
  taxableValue: Decimal.Value;
  cgstAmount: Decimal.Value;
  sgstAmount: Decimal.Value;
  igstAmount: Decimal.Value;
}

export interface PoTotals {
  subtotal: Decimal;
  discountAmount: Decimal;
  taxableAmount: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  freightAmount: Decimal;
  roundOff: Decimal;
  totalAmount: Decimal;
}

/**
 * Document totals from already-rounded line figures.
 *
 * `totalAmount` is whole rupees — that is the convention on an Indian tax
 * invoice — and `roundOff` carries the difference so the document still
 * reconciles to the paise. The two always satisfy
 * `taxable + tax + freight + roundOff === totalAmount`.
 */
export function sumPoTotals(items: TaxedLine[], freight: Decimal.Value = 0): PoTotals {
  // Per-line gross and discount, each rounded before it joins the sum (rule 1).
  const grosses = items.map((item) => round2(money(item.unitPrice).mul(item.quantity)));
  const discounts = items.map((item, index) =>
    round2(grosses[index]!.mul(money(item.discountPercent)).div(100)),
  );

  const subtotal = round2(sum(grosses));
  const discountAmount = round2(sum(discounts));
  const taxableAmount = round2(sum(items.map((item) => money(item.taxableValue))));
  const cgstAmount = round2(sum(items.map((item) => money(item.cgstAmount))));
  const sgstAmount = round2(sum(items.map((item) => money(item.sgstAmount))));
  const igstAmount = round2(sum(items.map((item) => money(item.igstAmount))));
  const freightAmount = round2(money(freight));

  const exact = taxableAmount
    .plus(cgstAmount)
    .plus(sgstAmount)
    .plus(igstAmount)
    .plus(freightAmount);

  const rounded = exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

  return {
    subtotal,
    discountAmount,
    taxableAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    freightAmount,
    roundOff: round2(rounded.minus(exact)),
    totalAmount: round2(rounded),
  };
}

/** The tax heads that apply, for a document that must never print both sets. */
export const taxHeadsFor = (regime: TaxRegime): ('CGST' | 'SGST' | 'IGST')[] => {
  if (regime === 'INTRA_STATE') return ['CGST', 'SGST'];
  if (regime === 'INTER_STATE') return ['IGST'];
  return [];
};

/** Total tax across every head, for display and for the three-way match (plan 12). */
export const totalTaxOf = (totals: Pick<PoTotals, 'cgstAmount' | 'sgstAmount' | 'igstAmount'>) =>
  round2(totals.cgstAmount.plus(totals.sgstAmount).plus(totals.igstAmount));
