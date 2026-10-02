import type { Invoice } from '@prisma/client';
import { BusinessRule } from '../../lib/errors.js';
import { money } from '../../lib/money.js';

/**
 * **The README's headline rule, encoded in exactly one place.**
 *
 * Plan 13 imports this and nothing else to decide whether money may leave the
 * building. When somebody asks "where is the rule that payment requires
 * delivery?", the answer is this file — and then the trace:
 *
 *   `APPROVED_FOR_PAYMENT` requires `matchStatus` MATCHED or OVERRIDDEN,
 *   which requires the quantity check to pass,
 *   which reads `PurchaseOrderItem.acceptedQuantity`,
 *   which is only ever written by a confirmed GRN.
 *
 * That trace is the whole control, and it is four files long.
 */
export type PayableInvoice = Pick<
  Invoice,
  'status' | 'matchStatus' | 'totalAmount' | 'amountPaid'
> & {
  purchaseOrder: { status: string };
};

export function assertPayable(invoice: PayableInvoice): void {
  if (invoice.status !== 'APPROVED_FOR_PAYMENT' && invoice.status !== 'PARTIALLY_PAID') {
    throw BusinessRule(
      'invoice.not_payable',
      `Invoice is not approved for payment (status ${invoice.status})`,
    );
  }

  if (invoice.purchaseOrder.status === 'CANCELLED') {
    throw BusinessRule('invoice.po_cancelled', 'The purchase order was cancelled');
  }

  // An override is a deliberate, attributable decision; an open exception is not.
  if (invoice.matchStatus === 'EXCEPTION') {
    throw BusinessRule('invoice.match_exception', 'Invoice has unresolved match exceptions');
  }

  if (money(invoice.amountPaid).greaterThanOrEqualTo(money(invoice.totalAmount))) {
    throw BusinessRule('invoice.already_settled', 'Invoice is already fully paid');
  }
}

/** The same question without the throw, for list screens and buttons. */
export function payableBlocker(invoice: PayableInvoice): string | null {
  try {
    assertPayable(invoice);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invoice is not payable';
  }
}

/** What is still owed. Never negative. */
export const outstandingOf = (invoice: Pick<Invoice, 'totalAmount' | 'amountPaid'>) => {
  const balance = money(invoice.totalAmount).minus(money(invoice.amountPaid));
  return balance.isNegative() ? money(0) : balance;
};
