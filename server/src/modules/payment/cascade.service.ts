import type { Prisma } from '@prisma/client';
import type { AuditActor } from '../../lib/audit.js';
import { writeAudit } from '../../lib/audit.js';
import { money } from '../../lib/money.js';
import { transitionPo } from '../purchase-order/po.stateMachine.js';
import { transitionTender } from '../tender/tender.stateMachine.js';

/**
 * The closure cascade (plan 13 §5) — **README step 16, implemented as a
 * consequence rather than a button.**
 *
 * Nobody clicks "close tender". It closes because everything downstream of it is
 * done: the last invoice against its purchase order was settled, that order was
 * fully received and fully invoiced, so the order closed, and it was the last
 * order on the tender. Record the final payment and the tender status changes on
 * the next screen with no user action in between.
 *
 * Every condition below is checked against stored rows rather than inferred, and
 * each one is a real reason an order should stay open:
 *
 *   fulfilled      — goods arrived, or the shortfall was deliberately written off
 *   fully invoiced — the vendor has billed everything they are entitled to
 *   all paid       — nothing is still owed
 *
 * An order missing any of the three stays open, which is why a partially
 * invoiced line keeps a paid order from closing.
 */

export interface CascadeResult {
  purchaseOrderClosed: boolean;
  tenderClosed: boolean;
}

/** Close the order if, and only if, nothing is outstanding against it. */
export async function maybeClosePurchaseOrder(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
  actor: AuditActor,
): Promise<CascadeResult> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { invoices: true, items: true },
  });
  if (!po || po.status !== 'ACCEPTED') {
    return { purchaseOrderClosed: false, tenderClosed: false };
  }

  const fulfilled =
    po.fulfilmentStatus === 'FULFILLED' || po.fulfilmentStatus === 'SHORT_CLOSED';

  // An order with no invoices has not been paid, it has simply not been billed.
  const allPaid =
    po.invoices.length > 0 &&
    po.invoices.every((invoice) => invoice.status === 'PAID' || invoice.status === 'CANCELLED');

  const fullyInvoiced = po.items.every((item) =>
    money(item.invoicedQuantity).greaterThanOrEqualTo(money(item.acceptedQuantity)),
  );

  if (!(fulfilled && allPaid && fullyInvoiced)) {
    return { purchaseOrderClosed: false, tenderClosed: false };
  }

  await transitionPo(tx, po, 'CLOSED', actor, {
    action: 'po.closed',
    summary: `${po.poNumber} closed automatically: fully received, fully invoiced and fully paid`,
    data: { closedAt: new Date() },
    after: { fulfilmentStatus: po.fulfilmentStatus, invoices: po.invoices.length },
  });

  const tenderClosed = po.tenderId ? await maybeCloseTender(tx, po.tenderId, actor) : false;
  return { purchaseOrderClosed: true, tenderClosed };
}

/** Close the tender once every order raised against it is closed or cancelled. */
export async function maybeCloseTender(
  tx: Prisma.TransactionClient,
  tenderId: string,
  actor: AuditActor,
): Promise<boolean> {
  const tender = await tx.tender.findUnique({ where: { id: tenderId } });
  if (!tender || tender.status !== 'AWARDED') return false;

  const orders = await tx.purchaseOrder.findMany({ where: { tenderId } });
  if (orders.length === 0) return false;

  const settled = orders.every(
    (order) => order.status === 'CLOSED' || order.status === 'CANCELLED',
  );
  if (!settled) return false;

  await transitionTender(tx, tender, 'CLOSED', actor, {
    action: 'tender.closed',
    summary: `${tender.referenceNumber || tender.title} closed automatically: every purchase order against it is settled`,
    data: { closedAt: new Date() },
    after: { purchaseOrders: orders.length },
  });

  return true;
}

/**
 * Undo the cascade after a bank reversal (plan 13 §6).
 *
 * The closure was automatic, so its reversal has to be too — otherwise a
 * returned payment leaves a CLOSED order with an unpaid invoice against it,
 * which is a ledger that lies. The audit rows are SECURITY severity: a closed
 * financial record reopening is exactly what an auditor wants to find.
 */
export async function reopenAfterReversal(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
  reason: string,
  actor: AuditActor,
): Promise<CascadeResult> {
  const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
  if (!po) return { purchaseOrderClosed: false, tenderClosed: false };

  let reopenedTender = false;

  if (po.tenderId) {
    const tender = await tx.tender.findUnique({ where: { id: po.tenderId } });
    if (tender && tender.status === 'CLOSED') {
      await transitionTender(tx, tender, 'AWARDED', actor, {
        action: 'tender.reopened',
        severity: 'SECURITY',
        summary: `${tender.referenceNumber || tender.title} reopened: ${reason}`,
        reason,
        data: { closedAt: null },
      });
      reopenedTender = true;
    }
  }

  if (po.status !== 'CLOSED') {
    return { purchaseOrderClosed: false, tenderClosed: reopenedTender };
  }

  await transitionPo(tx, po, 'ACCEPTED', actor, {
    action: 'po.reopened',
    severity: 'SECURITY',
    summary: `${po.poNumber} reopened: ${reason}`,
    reason,
    data: { closedAt: null },
  });

  await writeAudit(tx, {
    action: 'payment.cascade_reversed',
    entityType: 'PurchaseOrder',
    entityId: purchaseOrderId,
    severity: 'SECURITY',
    summary: `Closure cascade reversed on ${po.poNumber}${reopenedTender ? ' and its tender' : ''}: ${reason}`,
    organizationId: po.organizationId,
    vendorId: po.vendorId,
    actor,
    after: { purchaseOrderReopened: true, tenderReopened: reopenedTender, reason },
  });

  return { purchaseOrderClosed: true, tenderClosed: reopenedTender };
}
