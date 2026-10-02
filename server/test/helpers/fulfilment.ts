import request from 'supertest';
import { expect } from 'vitest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { openedForEvaluation, type BidFixture } from './bidding.js';

/**
 * An ACCEPTED purchase order, reached the long way: tender, bids, evaluation,
 * recommendation, approval, issue, vendor acceptance.
 *
 * Built through the API on purpose. Every guard in plans 07 to 10 has to pass
 * for this fixture to exist, so a regression upstream fails loudly here instead
 * of being mocked past — which is the whole point of fixtures that cost
 * something to build.
 */

const JUSTIFICATION =
  'Lowest evaluated cost with the shortest delivery window, and the vendor has completed prior networking orders on time.';

export interface AcceptedOrder {
  f: BidFixture;
  tenderId: string;
  poId: string;
  poNumber: string;
  /** PO lines, sorted by srNo. Line 1 is 12 units, line 2 is 24. */
  items: { id: string; srNo: number; quantity: string }[];
}

export async function acceptedOrder(): Promise<AcceptedOrder> {
  const { f, tender, bids } = await openedForEvaluation();

  await request(app)
    .post(`/api/v1/tenders/${tender.id}/recommend`)
    .set(...f.officer.authHeader)
    .send({ quotationId: bids[0]!.id, justification: JUSTIFICATION })
    .expect(200);

  const approval = await prisma.approval.findFirstOrThrow({ where: { entityId: tender.id } });
  await request(app)
    .post(`/api/v1/approvals/${approval.id}/decide`)
    .set(...f.admin.authHeader)
    .send({ decision: 'APPROVED', comment: 'Approved for issue.' })
    .expect(200);

  const po = await prisma.purchaseOrder.findFirstOrThrow({
    where: { tenderId: tender.id },
    include: { items: { orderBy: { srNo: 'asc' } } },
  });

  await request(app)
    .post(`/api/v1/purchase-orders/${po.id}/issue`)
    .set(...f.admin.authHeader)
    .expect(200);

  await request(app)
    .post(`/api/v1/vendor/purchase-orders/${po.id}/accept`)
    .set(...f.vendors[0]!.contact.authHeader)
    .send({})
    .expect(200);

  return {
    f,
    tenderId: tender.id,
    poId: po.id,
    poNumber: po.poNumber,
    items: po.items.map((item) => ({
      id: item.id,
      srNo: item.srNo,
      quantity: item.quantity.toFixed(3),
    })),
  };
}

/** The vendor raises a challan for `quantity` of one PO line. */
export const dispatch = (
  order: AcceptedOrder,
  lines: { purchaseOrderItemId: string; quantity: string }[],
  overrides: Record<string, unknown> = {},
) =>
  request(app)
    .post(`/api/v1/vendor/purchase-orders/${order.poId}/deliveries`)
    .set(...order.f.vendors[0]!.contact.authHeader)
    .send({
      challanNumber: `DC-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      dispatchedAt: new Date().toISOString(),
      items: lines,
      ...overrides,
    });

/** The buyer receipts goods against the order. */
export const receive = (
  order: AcceptedOrder,
  items: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) =>
  request(app)
    .post(`/api/v1/purchase-orders/${order.poId}/grns`)
    .set(...order.f.officer.authHeader)
    .send({ receivedAt: new Date().toISOString(), items, ...overrides });

/** One fully-accepted line, the common case. */
export const acceptLine = (purchaseOrderItemId: string, quantity: string) => ({
  purchaseOrderItemId,
  receivedQuantity: quantity,
  acceptedQuantity: quantity,
  rejectedQuantity: '0.000',
});

export const lineOf = async (purchaseOrderItemId: string) =>
  prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: purchaseOrderItemId } });

export const expectQuantities = async (
  purchaseOrderItemId: string,
  expected: { received: string; accepted: string; invoiced?: string },
) => {
  const line = await lineOf(purchaseOrderItemId);
  expect(line.receivedQuantity.toFixed(3)).toBe(expected.received);
  expect(line.acceptedQuantity.toFixed(3)).toBe(expected.accepted);
  if (expected.invoiced !== undefined) {
    expect(line.invoicedQuantity.toFixed(3)).toBe(expected.invoiced);
  }
};
