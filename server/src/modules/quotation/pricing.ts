import { Decimal, money, round2, round3, sum } from '../../lib/money.js';

/**
 * Quotation pricing (08 §4). A pure function: no Prisma, no Express, no clock.
 * Everything it needs arrives as arguments, which is why `pricing.spec.ts` can
 * check twenty lines of arithmetic without touching the database.
 *
 * **Round each line, then sum. Never sum, then round.** On a twenty-line
 * quotation the two differ by rupees, and the second is the wrong one: the
 * stored line totals would not add up to the stored grand total, and the vendor
 * would be invoicing against figures the buyer's PO does not agree with. The
 * same rule governs plans 10 and 12.
 */

export interface PricingLineInput {
  tenderItemId: string;
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  discountPercent?: Decimal.Value;
  deliveryDays?: number | null;
  brandOrMake?: string | null;
  remarks?: string | null;
}

/** The buyer owns the tax rate, not the vendor — it comes off the tender line. */
export interface TenderLineContext {
  tenderItemId: string;
  taxRatePercent: Decimal.Value;
}

export interface PricedLine {
  tenderItemId: string;
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent: Decimal;
  /** quantity × unitPrice, before discount. Reported, never stored. */
  grossAmount: Decimal;
  discountAmount: Decimal;
  taxableValue: Decimal;
  taxRatePercent: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
  deliveryDays: number | null;
  brandOrMake: string | null;
  remarks: string | null;
}

export interface PricedQuotation {
  lines: PricedLine[];
  subtotal: Decimal;
  discountAmount: Decimal;
  taxableAmount: Decimal;
  taxAmount: Decimal;
  freightAmount: Decimal;
  grandTotal: Decimal;
}

/** One line, five rounded figures. */
export function priceLine(input: PricingLineInput, taxRatePercent: Decimal.Value): PricedLine {
  const quantity = round3(money(input.quantity));
  const unitPrice = round2(money(input.unitPrice));
  const discountPercent = round2(money(input.discountPercent));
  const taxRate = round2(money(taxRatePercent));

  const grossAmount = round2(unitPrice.mul(quantity));
  const discountAmount = round2(grossAmount.mul(discountPercent).div(100));
  const taxableValue = round2(grossAmount.minus(discountAmount));
  const taxAmount = round2(taxableValue.mul(taxRate).div(100));
  const lineTotal = round2(taxableValue.plus(taxAmount));

  return {
    tenderItemId: input.tenderItemId,
    quantity,
    unitPrice,
    discountPercent,
    grossAmount,
    discountAmount,
    taxableValue,
    taxRatePercent: taxRate,
    taxAmount,
    lineTotal,
    deliveryDays: input.deliveryDays ?? null,
    brandOrMake: input.brandOrMake ?? null,
    remarks: input.remarks ?? null,
  };
}

/**
 * The whole document. Lines are priced in the order given and the totals are
 * sums of already-rounded line figures.
 *
 * Freight is a document-level charge and is deliberately untaxed here: the
 * tender's tax rates belong to its goods lines, and inventing a rate for
 * freight would put a number on the invoice that nobody quoted.
 */
export function recomputeTotals(
  items: PricingLineInput[],
  tenderLines: TenderLineContext[],
  freight: Decimal.Value = 0,
): PricedQuotation {
  const taxRateByItem = new Map(tenderLines.map((line) => [line.tenderItemId, line.taxRatePercent]));

  const lines = items.map((item) => {
    const taxRatePercent = taxRateByItem.get(item.tenderItemId);
    if (taxRatePercent === undefined) {
      // A caller that has not already validated the line set is a bug, not a
      // user error — the service rejects unknown ids with a 422 before this.
      throw new Error(`No tender line ${item.tenderItemId} to price against`);
    }
    return priceLine(item, taxRatePercent);
  });

  const subtotal = round2(sum(lines.map((line) => line.grossAmount)));
  const discountAmount = round2(sum(lines.map((line) => line.discountAmount)));
  const taxableAmount = round2(sum(lines.map((line) => line.taxableValue)));
  const taxAmount = round2(sum(lines.map((line) => line.taxAmount)));
  const freightAmount = round2(money(freight));
  const grandTotal = round2(taxableAmount.plus(taxAmount).plus(freightAmount));

  return { lines, subtotal, discountAmount, taxableAmount, taxAmount, freightAmount, grandTotal };
}
