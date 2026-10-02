import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { deriveGrnStatus } from '../src/modules/grn/grn.service.js';
import {
  acceptLine,
  acceptedOrder,
  dispatch,
  expectQuantities,
  lineOf,
  receive,
  type AcceptedOrder,
} from './helpers/fulfilment.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Deliveries and goods receipt. Each test builds a full tender-to-accepted-order
 * chain over the Neon test branch, so this file needs the same headroom as the
 * other integration suites.
 */
vi.setConfig({ testTimeout: 180_000 });

const vendorAuth = (order: AcceptedOrder, index = 0) =>
  order.f.vendors[index]!.contact.authHeader;

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Derived GRN status — pure                                                  */
/* -------------------------------------------------------------------------- */

describe('deriveGrnStatus', () => {
  it('is ACCEPTED when nothing was rejected', () => {
    expect(
      deriveGrnStatus([
        { acceptedQuantity: '8', rejectedQuantity: '0' },
        { acceptedQuantity: '4', rejectedQuantity: '0' },
      ]),
    ).toBe('ACCEPTED');
  });

  it('is REJECTED when nothing was accepted', () => {
    expect(
      deriveGrnStatus([
        { acceptedQuantity: '0', rejectedQuantity: '8' },
        { acceptedQuantity: '0', rejectedQuantity: '4' },
      ]),
    ).toBe('REJECTED');
  });

  it('is PARTIALLY_ACCEPTED for anything in between', () => {
    expect(
      deriveGrnStatus([{ acceptedQuantity: '7', rejectedQuantity: '1' }]),
    ).toBe('PARTIALLY_ACCEPTED');
    expect(
      deriveGrnStatus([
        { acceptedQuantity: '8', rejectedQuantity: '0' },
        { acceptedQuantity: '0', rejectedQuantity: '4' },
      ]),
    ).toBe('PARTIALLY_ACCEPTED');
  });
});

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

describe('delivery', () => {
  it('dispatches part of a line and leaves the order untouched', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    const res = await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '8.000' }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('DISPATCHED');
    expect(res.body.data.items[0].quantity).toBe('8.000');
    expect(res.body.data.fullyReceipted).toBe(false);

    /*
     * A delivery is a claim, not a fact. Nothing on the order line moves until
     * the buyer receipts it — that asymmetry is the control.
     */
    await expectQuantities(line.id, { received: '0.000', accepted: '0.000' });

    const notified = await prisma.notification.count({
      where: { type: 'DELIVERY_DISPATCHED', userId: order.f.officer.user.id },
    });
    expect(notified).toBe(1);
  });

  /** Plan 11 §9 — 8 of 12, then another 6, must fail cumulatively. */
  it('refuses a dispatch that exceeds the ordered quantity cumulatively', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '8.000' }]).expect(201);

    const second = await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '6.000' }]);

    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('delivery.exceeds_ordered');
  });

  it('allows a second dispatch that fits in what is left', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '8.000' }]).expect(201);
    await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '4.000' }]).expect(201);
  });

  /** Plan 11 §9 — cancelling frees the claimed quantity again. */
  it('frees the quantity when a delivery is cancelled', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    const first = await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '8.000' }]);
    expect(first.status).toBe(201);

    await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '6.000' }]).expect(422);

    await request(app)
      .post(`/api/v1/vendor/deliveries/${first.body.data.id}/cancel`)
      .set(...vendorAuth(order))
      .send({ reason: 'Loaded onto the wrong vehicle' })
      .expect(200);

    // The same 6 is acceptable now.
    await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '6.000' }]).expect(201);
  });

  it('refuses a line that belongs to another order', async () => {
    const order = await acceptedOrder();
    const other = await acceptedOrder();

    const res = await dispatch(order, [
      { purchaseOrderItemId: other.items[0]!.id, quantity: '1.000' },
    ]);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('delivery.invalid_item');
  });

  it('refuses a dispatch date in the future', async () => {
    const order = await acceptedOrder();

    const res = await dispatch(
      order,
      [{ purchaseOrderItemId: order.items[0]!.id, quantity: '1.000' }],
      { dispatchedAt: new Date(Date.now() + 86_400_000).toISOString() },
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('delivery.invalid_date');
  });

  it('refuses to dispatch against an order that is not accepted', async () => {
    const order = await acceptedOrder();
    await prisma.purchaseOrder.update({
      where: { id: order.poId },
      data: { status: 'ISSUED', acceptedAt: null },
    });

    const res = await dispatch(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '1.000' },
    ]);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('delivery.po_not_accepted');
  });

  it("hides a challan from another vendor", async () => {
    const order = await acceptedOrder();
    const created = await dispatch(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '2.000' },
    ]);
    expect(created.status).toBe(201);

    await request(app)
      .get(`/api/v1/deliveries/${created.body.data.id}`)
      .set(...vendorAuth(order, 1))
      .expect(404);

    // The buyer, though, must be able to see it.
    await request(app)
      .get(`/api/v1/deliveries/${created.body.data.id}`)
      .set(...order.f.officer.authHeader)
      .expect(200);
  });

  it('cannot be edited once it has been receipted', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;
    const created = await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '8.000' }]);

    await receive(order, [acceptLine(line.id, '8.000')], {
      deliveryId: created.body.data.id,
    }).expect(201);

    const res = await request(app)
      .patch(`/api/v1/vendor/deliveries/${created.body.data.id}`)
      .set(...vendorAuth(order))
      .send({ carrierName: 'Someone else' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('delivery.already_received');
  });
});

/* -------------------------------------------------------------------------- */
/* Receivable worklist                                                        */
/* -------------------------------------------------------------------------- */

describe('receivable worklist', () => {
  it('prefills what is pending and what is on its way', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;
    await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '8.000' }]).expect(201);

    const res = await request(app)
      .get(`/api/v1/purchase-orders/${order.poId}/receivable`)
      .set(...order.f.officer.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.purchaseOrder.poNumber).toBe(order.poNumber);
    expect(res.body.data.openDeliveries).toHaveLength(1);

    const prefill = res.body.data.lines.find(
      (l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === line.id,
    );
    expect(prefill.ordered).toBe('12.000');
    expect(prefill.alreadyReceived).toBe('0.000');
    expect(prefill.pending).toBe('12.000');
    expect(prefill.suggestedReceive).toBe('8.000');

    // A line with nothing in transit suggests nothing.
    const untouched = res.body.data.lines.find(
      (l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === order.items[1]!.id,
    );
    expect(untouched.suggestedReceive).toBe('0.000');
  });

  it('never suggests more than is still pending', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '8.000' }]).expect(201);
    await receive(order, [acceptLine(line.id, '8.000')]).expect(201);
    await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '4.000' }]).expect(201);

    const res = await request(app)
      .get(`/api/v1/purchase-orders/${order.poId}/receivable`)
      .set(...order.f.officer.authHeader);

    const prefill = res.body.data.lines.find(
      (l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === line.id,
    );
    expect(prefill.alreadyReceived).toBe('8.000');
    expect(prefill.pending).toBe('4.000');
    expect(prefill.suggestedReceive).toBe('4.000');
  });
});

/* -------------------------------------------------------------------------- */
/* GRN                                                                        */
/* -------------------------------------------------------------------------- */

describe('goods receipt', () => {
  /** Plan 11 §9 — the headline reconciliation case. */
  it('moves the running totals and the derived fulfilment status', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;
    const challan = await dispatch(order, [
      { purchaseOrderItemId: line.id, quantity: '8.000' },
    ]);

    const res = await receive(
      order,
      [
        {
          purchaseOrderItemId: line.id,
          receivedQuantity: '8.000',
          acceptedQuantity: '7.000',
          rejectedQuantity: '1.000',
          rejectionReason: 'Physical damage to chassis, unit 3',
        },
      ],
      { deliveryId: challan.body.data.id, remarks: 'One carton damaged in transit' },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.grnNumber).toMatch(/^GRN\/\d{4}-\d{2}\/\d{6}$/);
    expect(res.body.data.status).toBe('PARTIALLY_ACCEPTED');

    // Rejected units are not received goods: accepted stops at 7.
    await expectQuantities(line.id, { received: '8.000', accepted: '7.000', invoiced: '0.000' });

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.fulfilmentStatus).toBe('PARTIALLY_FULFILLED');

    // And `pendingInvoice` is the 7 that were accepted.
    const fulfilment = await request(app)
      .get(`/api/v1/purchase-orders/${order.poId}/fulfilment`)
      .set(...order.f.officer.authHeader);
    const row = fulfilment.body.data.lines.find(
      (l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === line.id,
    );
    expect(row.pendingInvoice).toBe('7.000');
    expect(row.pendingDelivery).toBe('4.000');
    expect(row.rejected).toBe('1.000');
  });

  /** Plan 11 §9 — received 8 / accepted 7 / rejected 0 does not reconcile. */
  it('refuses a receipt whose quantities do not add up', async () => {
    const order = await acceptedOrder();

    const res = await receive(order, [
      {
        purchaseOrderItemId: order.items[0]!.id,
        receivedQuantity: '8.000',
        acceptedQuantity: '7.000',
        rejectedQuantity: '0.000',
      },
    ]);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('grn.quantity_mismatch');
  });

  /**
   * Plan 11 §9 — the same payload is refused by the database too. The service
   * check is the message; the CHECK constraint is the guarantee.
   */
  it('is rejected by the CHECK constraint when written directly', async () => {
    const order = await acceptedOrder();
    const grn = await prisma.grn.create({
      data: {
        organizationId: order.f.org.id,
        purchaseOrderId: order.poId,
        grnNumber: `GRN-DIRECT-${Date.now()}`,
        status: 'ACCEPTED',
        receivedById: order.f.officer.user.id,
        receivedAt: new Date(),
      },
    });

    await expect(
      prisma.grnItem.create({
        data: {
          grnId: grn.id,
          purchaseOrderItemId: order.items[0]!.id,
          receivedQuantity: '8.000',
          acceptedQuantity: '7.000',
          rejectedQuantity: '0.000',
        },
      }),
    ).rejects.toThrow(/grn_quantity_reconciles/);
  });

  /** Plan 11 §9 — rejecting without saying why gives the vendor nothing to fix. */
  it('demands a reason when anything is rejected', async () => {
    const order = await acceptedOrder();

    const res = await receive(order, [
      {
        purchaseOrderItemId: order.items[0]!.id,
        receivedQuantity: '8.000',
        acceptedQuantity: '7.000',
        rejectedQuantity: '1.000',
      },
    ]);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('grn.rejection_reason_required');
  });

  it('refuses a cumulative over-receipt', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    await receive(order, [acceptLine(line.id, '8.000')]).expect(201);

    const second = await receive(order, [acceptLine(line.id, '6.000')]);

    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('grn.exceeds_ordered');
    await expectQuantities(line.id, { received: '8.000', accepted: '8.000' });
  });

  it('refuses a receipt dated before the order was issued', async () => {
    const order = await acceptedOrder();

    const res = await receive(order, [acceptLine(order.items[0]!.id, '1.000')], {
      receivedAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('grn.invalid_date');
  });

  it('refuses a challan that belongs to a different order', async () => {
    const order = await acceptedOrder();
    const other = await acceptedOrder();
    const foreign = await dispatch(other, [
      { purchaseOrderItemId: other.items[0]!.id, quantity: '2.000' },
    ]);

    const res = await receive(order, [acceptLine(order.items[0]!.id, '1.000')], {
      deliveryId: foreign.body.data.id,
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('grn.delivery_mismatch');
  });

  /** Plan 11 §9 — a wholly rejected shipment accepts nothing. */
  it('leaves accepted at zero when a whole line is rejected', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    const res = await receive(order, [
      {
        purchaseOrderItemId: line.id,
        receivedQuantity: '8.000',
        acceptedQuantity: '0.000',
        rejectedQuantity: '8.000',
        rejectionReason: 'Entire pallet water damaged, refused on arrival',
      },
    ]);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('REJECTED');
    await expectQuantities(line.id, { received: '8.000', accepted: '0.000' });

    // Nothing is invoiceable.
    const fulfilment = await request(app)
      .get(`/api/v1/purchase-orders/${order.poId}/fulfilment`)
      .set(...order.f.officer.authHeader);
    const row = fulfilment.body.data.lines.find(
      (l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === line.id,
    );
    expect(row.pendingInvoice).toBe('0.000');

    // And both sides were told, with the reason.
    const rejection = await prisma.notification.findFirstOrThrow({
      where: { type: 'GRN_REJECTION' },
    });
    expect(rejection.body).toMatch(/water damaged/);
  });

  /** Plan 11 §8 — the replacement flow should need no new code. */
  it('handles a replacement shipment with no special case', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    // 8 sent, 1 rejected.
    await receive(order, [
      {
        purchaseOrderItemId: line.id,
        receivedQuantity: '8.000',
        acceptedQuantity: '7.000',
        rejectedQuantity: '1.000',
        rejectionReason: 'Physical damage to chassis, unit 3',
      },
    ]).expect(201);

    // The rejected unit is still outstanding, so 4 remain dispatchable.
    await dispatch(order, [{ purchaseOrderItemId: line.id, quantity: '4.000' }]).expect(201);
    await receive(order, [acceptLine(line.id, '4.000')]).expect(201);

    await expectQuantities(line.id, { received: '12.000', accepted: '11.000' });

    // 12 received of 12 ordered, so the line is done even though one was refused.
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.fulfilmentStatus).toBe('PARTIALLY_FULFILLED'); // line 2 is untouched
  });

  it('marks a challan DELIVERED once it is fully receipted', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;
    const challan = await dispatch(order, [
      { purchaseOrderItemId: line.id, quantity: '8.000' },
    ]);

    await receive(order, [acceptLine(line.id, '8.000')], {
      deliveryId: challan.body.data.id,
    }).expect(201);

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: challan.body.data.id },
    });
    expect(row.status).toBe('DELIVERED');
    expect(row.deliveredAt).toBeTruthy();
  });

  /** Plan 11 §9 — fulfilment and contract lifecycle are separate axes. */
  it('reaches FULFILLED without touching the order status', async () => {
    const order = await acceptedOrder();

    for (const line of order.items) {
      await receive(order, [acceptLine(line.id, line.quantity)]).expect(201);
    }

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.fulfilmentStatus).toBe('FULFILLED');
    // Still ACCEPTED, not CLOSED: plan 13 closes it once it is paid too.
    expect(po.status).toBe('ACCEPTED');

    const fulfilled = await prisma.notification.count({
      where: { title: { contains: 'fully received' } },
    });
    expect(fulfilled).toBeGreaterThan(0);
  });

  it('lets the vendor read the receipt against their own order', async () => {
    const order = await acceptedOrder();
    const created = await receive(order, [acceptLine(order.items[0]!.id, '2.000')]);
    expect(created.status).toBe(201);

    const mine = await request(app)
      .get(`/api/v1/grns/${created.body.data.id}`)
      .set(...vendorAuth(order));
    expect(mine.status).toBe(200);
    expect(mine.body.data.grnNumber).toBe(created.body.data.grnNumber);

    // But not another vendor's.
    await request(app)
      .get(`/api/v1/grns/${created.body.data.id}`)
      .set(...vendorAuth(order, 1))
      .expect(404);
  });

  it('cannot be given a status by the client', async () => {
    const order = await acceptedOrder();

    const res = await receive(
      order,
      [
        {
          purchaseOrderItemId: order.items[0]!.id,
          receivedQuantity: '8.000',
          acceptedQuantity: '0.000',
          rejectedQuantity: '8.000',
          rejectionReason: 'Entire pallet water damaged, refused on arrival',
        },
      ],
      { status: 'ACCEPTED' },
    );

    // `.strict()` refuses the unknown key outright.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

/* -------------------------------------------------------------------------- */
/* Short close                                                                */
/* -------------------------------------------------------------------------- */

describe('short close', () => {
  /** Plan 11 §9 — the written-off quantity lands on the audit row. */
  it('writes off the remainder and records what was given up', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;
    await receive(order, [acceptLine(line.id, '8.000')]).expect(201);

    const res = await request(app)
      .post(`/api/v1/purchase-orders/${order.poId}/short-close`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'Vendor cannot supply the balance before the shutdown' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.fulfilmentStatus).toBe('SHORT_CLOSED');
    // The contract status is untouched.
    expect(res.body.data.status).toBe('ACCEPTED');

    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'po.short_closed', entityId: order.poId },
    });
    expect(entry.severity).toBe('NOTABLE');
    const after = JSON.stringify(entry.after);
    // 4 left on line 1 plus all 24 of line 2.
    expect(after).toContain('28.000');
    expect(after).toMatch(/writtenOffValue/);

    const told = await prisma.notification.count({
      where: { title: { contains: 'short-closed' } },
    });
    expect(told).toBeGreaterThan(0);
  });

  /** Writing off contracted goods is a financial decision, so an admin does it. */
  it('is withheld from an officer by the role matrix', async () => {
    const order = await acceptedOrder();

    const res = await request(app)
      .post(`/api/v1/purchase-orders/${order.poId}/short-close`)
      .set(...order.f.officer.authHeader)
      .send({ reason: 'Vendor cannot supply the balance before the shutdown' });

    expect(res.status).toBe(403);
  });

  it('demands a reason of at least 20 characters', async () => {
    const order = await acceptedOrder();

    const res = await request(app)
      .post(`/api/v1/purchase-orders/${order.poId}/short-close`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'Gave up' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('survives later receipts — a signed write-off is not undone by accumulation', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;
    await receive(order, [acceptLine(line.id, '8.000')]).expect(201);

    await request(app)
      .post(`/api/v1/purchase-orders/${order.poId}/short-close`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'Vendor cannot supply the balance before the shutdown' })
      .expect(200);

    // A late delivery of the balance arrives anyway.
    await receive(order, [acceptLine(line.id, '4.000')]).expect(201);

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.fulfilmentStatus).toBe('SHORT_CLOSED');
    // The quantities still moved; only the decision is sticky.
    const row = await lineOf(line.id);
    expect(row.receivedQuantity.toFixed(3)).toBe('12.000');
  });

  it('refuses when there is nothing outstanding', async () => {
    const order = await acceptedOrder();
    for (const line of order.items) {
      await receive(order, [acceptLine(line.id, line.quantity)]).expect(201);
    }

    const res = await request(app)
      .post(`/api/v1/purchase-orders/${order.poId}/short-close`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'Nothing left to write off, this should fail' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('po.nothing_outstanding');
  });
});
