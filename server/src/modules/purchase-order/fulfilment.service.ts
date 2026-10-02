import type { Prisma, PurchaseOrder, PurchaseOrderItem } from '@prisma/client';
import type { FulfilmentDto, FulfilmentLineDto, LineFulfilmentStatus } from '@tb/shared';
import { money, qtyToApi, round2, sum, toApi, ZERO, type Decimal } from '../../lib/money.js';

/**
 * The fulfilment read model (10 §6).
 *
 * **Computed, never stored twice.** `pendingDelivery` and `pendingInvoice` are
 * derived here and nowhere else, because three modules otherwise end up
 * disagreeing about what "remaining" means — plan 11 when it records a goods
 * receipt, plan 12 when it prefills an invoice, and the screen the buyer is
 * looking at. One definition, one place.
 *
 *   pendingDelivery = ordered  − received
 *   pendingInvoice  = accepted − invoiced
 *
 * The running totals on `PurchaseOrderItem` (`receivedQuantity`,
 * `acceptedQuantity`, `invoicedQuantity`) are the only stored numbers, and they
 * are written exclusively inside plan 11's and plan 12's transactions.
 */

export type PoWithItems = PurchaseOrder & { items: PurchaseOrderItem[] };

const lineStatus = (ordered: Decimal, received: Decimal): LineFulfilmentStatus => {
  if (received.greaterThan(ordered)) return 'OVER_RECEIVED';
  if (received.isZero()) return 'PENDING';
  return received.greaterThanOrEqualTo(ordered) ? 'COMPLETE' : 'PARTIAL';
};

/** Never negative: an over-receipt leaves nothing pending, it does not owe quantity back. */
const remaining = (a: Decimal, b: Decimal): Decimal => {
  const diff = a.minus(b);
  return diff.isNegative() ? ZERO : diff;
};

export function buildFulfilment(po: PoWithItems): FulfilmentDto {
  const lines: FulfilmentLineDto[] = [...po.items]
    .sort((a, b) => a.srNo - b.srNo)
    .map((item) => {
      const ordered = money(item.quantity);
      const received = money(item.receivedQuantity);
      const accepted = money(item.acceptedQuantity);
      const invoiced = money(item.invoicedQuantity);

      return {
        purchaseOrderItemId: item.id,
        srNo: item.srNo,
        description: item.description,
        unit: item.unit,
        ordered: qtyToApi(ordered),
        received: qtyToApi(received),
        accepted: qtyToApi(accepted),
        // Rejected is what arrived and was refused, which is received − accepted.
        rejected: qtyToApi(remaining(received, accepted)),
        invoiced: qtyToApi(invoiced),
        pendingDelivery: qtyToApi(remaining(ordered, received)),
        pendingInvoice: qtyToApi(remaining(accepted, invoiced)),
        status: lineStatus(ordered, received),
      };
    });

  const orderedValue = round2(sum(po.items.map((item) => money(item.lineTotal))));

  // Progress by quantity, not by value: a part-delivered cheap line and a
  // part-delivered expensive line are equally undelivered to the storekeeper.
  const orderedQty = sum(po.items.map((item) => money(item.quantity)));
  const receivedQty = sum(po.items.map((item) => money(item.receivedQuantity)));

  const invoicedValue = round2(
    sum(
      po.items.map((item) => {
        const qty = money(item.quantity);
        if (qty.isZero()) return ZERO;
        // Value is apportioned by the share of the line actually invoiced.
        return money(item.lineTotal).mul(money(item.invoicedQuantity)).div(qty);
      }),
    ),
  );

  return {
    purchaseOrderId: po.id,
    fulfilmentStatus: po.fulfilmentStatus,
    overall: {
      orderedValue: toApi(orderedValue),
      receivedPercent: orderedQty.isZero()
        ? '0.00'
        : round2(receivedQty.div(orderedQty).mul(100)).toFixed(2),
      invoicedValue: toApi(invoicedValue),
      // Payments land in plan 13; until then nothing has been paid.
      paidValue: '0.00',
    },
    lines,
  };
}

/**
 * Derive `fulfilmentStatus` from the stored quantities and write it.
 *
 * Called by plan 11 from inside its goods-receipt transaction. It is idempotent
 * and takes no opinion of its own: the quantities are the truth, this is only
 * the summary of them.
 *
 * `SHORT_CLOSED` is not derived — it is a deliberate buyer decision to stop
 * waiting for the remainder, so only an explicit call sets it.
 */
export async function recomputeFulfilment(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
): Promise<PurchaseOrder> {
  const po = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: { items: true },
  });

  if (po.fulfilmentStatus === 'SHORT_CLOSED') return po;

  const ordered = sum(po.items.map((item) => money(item.quantity)));
  const received = sum(po.items.map((item) => money(item.receivedQuantity)));

  const fulfilmentStatus = received.isZero()
    ? 'NOT_STARTED'
    : received.greaterThanOrEqualTo(ordered)
      ? 'FULFILLED'
      : 'PARTIALLY_FULFILLED';

  if (fulfilmentStatus === po.fulfilmentStatus) return po;

  return tx.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: { fulfilmentStatus },
  });
}
