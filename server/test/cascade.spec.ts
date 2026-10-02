import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { acceptLine, receive } from './helpers/fulfilment.js';
import {
  completePayment,
  failPayment,
  payInFull,
  payableInvoice,
  recordPayment,
  withBankDetails,
  type PayableInvoice,
} from './helpers/payable.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * The closure cascade — **README step 16, proved.**
 *
 * The claim worth being able to make out loud is: *"no user action closed that
 * tender; it closed because the last invoice against its purchase order was
 * settled."* These tests are what make that sentence true rather than a hope.
 */
vi.setConfig({ testTimeout: 200_000 });

/**
 * An order where **everything** has been received, invoiced and approved, so the
 * final payment should close the order and the tender.
 *
 * Both lines are fully receipted and billed on one invoice, because the cascade
 * refuses to close an order with anything still outstanding — which is the
 * point of the negative tests below.
 */
async function fullyBilledOrder() {
  const base = await withBankDetails(await payableInvoice('24.000'));
  const order = base.order;

  // Line 2 is already received and invoiced by the fixture; finish line 1.
  await receive(order, [acceptLine(order.items[0]!.id, order.items[0]!.quantity)]).expect(201);

  const poItem = await prisma.purchaseOrderItem.findUniqueOrThrow({
    where: { id: order.items[0]!.id },
  });

  const draft = await request(app)
    .post(`/api/v1/vendor/purchase-orders/${order.poId}/invoices`)
    .set(...order.f.vendors[0]!.contact.authHeader)
    .send({
      vendorInvoiceNumber: `VINV-LINE1-${Date.now()}`,
      invoiceDate: new Date().toISOString(),
      items: [
        {
          purchaseOrderItemId: order.items[0]!.id,
          quantity: order.items[0]!.quantity,
          unitPrice: poItem.unitPrice.toFixed(2),
        },
      ],
    });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);

  const submitted = await request(app)
    .post(`/api/v1/vendor/invoices/${draft.body.data.id}/submit`)
    .set(...order.f.vendors[0]!.contact.authHeader);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  expect(submitted.body.data.matchStatus).toBe('MATCHED');

  // Line 1 is expensive, so this one goes through the approval engine.
  const approve = await request(app)
    .post(`/api/v1/invoices/${draft.body.data.id}/approve`)
    .set(...order.f.admin.authHeader)
    .send({});
  expect(approve.status, JSON.stringify(approve.body)).toBe(200);

  if (approve.body.data.status !== 'APPROVED_FOR_PAYMENT') {
    const approval = await prisma.approval.findFirstOrThrow({
      where: { entityType: 'INVOICE', entityId: draft.body.data.id, status: 'PENDING' },
    });
    await request(app)
      .post(`/api/v1/approvals/${approval.id}/decide`)
      .set(...order.f.approver.authHeader)
      .send({ decision: 'APPROVED', comment: 'Checked against the goods receipt.' })
      .expect(200);
  }

  const bigInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.body.data.id } });
  expect(bigInvoice.status).toBe('APPROVED_FOR_PAYMENT');

  return {
    order,
    smallInvoice: base,
    bigInvoice: {
      ...base,
      invoiceId: bigInvoice.id,
      totalAmount: bigInvoice.totalAmount.toFixed(2),
    } satisfies PayableInvoice,
  };
}

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

describe('automatic closure', () => {
  /**
   * Plan 13 §10 — the demo. Record the final payment; the order and the tender
   * close with no user action in between, and both have audit rows saying so.
   */
  it('closes the purchase order and the tender when the last invoice settles', async () => {
    const { order, smallInvoice, bigInvoice } = await fullyBilledOrder();

    // Pay the first invoice: nothing should close yet, one is still outstanding.
    await payInFull(smallInvoice);

    let po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.status).toBe('ACCEPTED');
    expect(po.fulfilmentStatus).toBe('FULFILLED');

    // Pay the last one.
    await payInFull(bigInvoice);

    po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.status).toBe('CLOSED');
    expect(po.closedAt).toBeTruthy();

    const tender = await prisma.tender.findUniqueOrThrow({ where: { id: order.tenderId } });
    expect(tender.status).toBe('CLOSED');
    expect(tender.closedAt).toBeTruthy();

    // Both closures are on the record, and neither was a user action.
    const poClosed = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'po.closed', entityId: order.poId },
    });
    expect(poClosed.summary).toMatch(/closed automatically/);

    const tenderClosed = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'tender.closed', entityId: order.tenderId },
    });
    expect(tenderClosed.summary).toMatch(/closed automatically/);
  });

  /** Plan 13 §10 — a partially invoiced line keeps the order open. */
  it('does not close an order with a line that is not fully invoiced', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const order = payable.order;

    // Receive everything, so fulfilment is complete...
    await receive(order, [acceptLine(order.items[0]!.id, order.items[0]!.quantity)]).expect(201);
    await receive(order, [acceptLine(order.items[1]!.id, '23.000')]).expect(201);

    // ...but only one unit of one line was ever invoiced.
    await payInFull(payable);

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.fulfilmentStatus).toBe('FULFILLED');
    // Paid in full as far as its one invoice goes, and still open.
    expect(po.status).toBe('ACCEPTED');

    const tender = await prisma.tender.findUniqueOrThrow({ where: { id: order.tenderId } });
    expect(tender.status).toBe('AWARDED');
  });

  /** Goods still outstanding keep it open even if everything billed is paid. */
  it('does not close an order that has not been fully received', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await payInFull(payable);

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: payable.order.poId } });
    expect(po.fulfilmentStatus).toBe('PARTIALLY_FULFILLED');
    expect(po.status).toBe('ACCEPTED');
  });

  /** A part payment is not a settlement. */
  it('does not close anything on a partial payment', async () => {
    const { order, smallInvoice } = await fullyBilledOrder();
    const half = (Number(smallInvoice.totalAmount) / 2).toFixed(2);

    const recorded = await recordPayment(smallInvoice, { grossAmount: half });
    expect(recorded.status).toBe(201);
    await completePayment(smallInvoice, recorded.body.data.id).expect(200);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: smallInvoice.invoiceId } });
    expect(invoice.status).toBe('PARTIALLY_PAID');

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.status).toBe('ACCEPTED');
  });

  /** A short-closed order is "fulfilled" for closure purposes — §5. */
  it('closes a short-closed order once its invoices are paid', async () => {
    const payable = await withBankDetails(await payableInvoice('24.000'));
    const order = payable.order;

    // Line 1 never arrives; the buyer writes it off.
    await request(app)
      .post(`/api/v1/purchase-orders/${order.poId}/short-close`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'Vendor cannot supply the balance before the plant shutdown' })
      .expect(200);

    await payInFull(payable);

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.fulfilmentStatus).toBe('SHORT_CLOSED');
    expect(po.status).toBe('CLOSED');

    const tender = await prisma.tender.findUniqueOrThrow({ where: { id: order.tenderId } });
    expect(tender.status).toBe('CLOSED');
  });
});

describe('reversing the cascade', () => {
  /**
   * Plan 13 §10 — the closure was automatic, so its reversal must be too.
   * Otherwise a returned payment leaves a CLOSED order with an unpaid invoice
   * against it, which is a ledger that lies.
   */
  it('reopens the purchase order and the tender when the final payment fails', async () => {
    const { order, smallInvoice, bigInvoice } = await fullyBilledOrder();

    await payInFull(smallInvoice);
    const { paymentId } = await payInFull(bigInvoice);

    expect(
      (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } })).status,
    ).toBe('CLOSED');
    expect((await prisma.tender.findUniqueOrThrow({ where: { id: order.tenderId } })).status).toBe(
      'CLOSED',
    );

    await failPayment(
      bigInvoice,
      paymentId,
      'Bank returned the transfer: beneficiary account frozen',
    ).expect(200);

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.status).toBe('ACCEPTED');
    expect(po.closedAt).toBeNull();

    const tender = await prisma.tender.findUniqueOrThrow({ where: { id: order.tenderId } });
    expect(tender.status).toBe('AWARDED');
    expect(tender.closedAt).toBeNull();

    // The invoice owes money again.
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: bigInvoice.invoiceId } });
    expect(invoice.status).toBe('APPROVED_FOR_PAYMENT');
    expect(invoice.amountPaid.toFixed(2)).toBe('0.00');

    // Reopening a closed financial record is a SECURITY event.
    const reopened = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'po.reopened', entityId: order.poId },
    });
    expect(reopened.severity).toBe('SECURITY');

    const cascadeReversed = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'payment.cascade_reversed', entityId: order.poId },
    });
    expect(cascadeReversed.severity).toBe('SECURITY');
  });

  it('can be paid again after the reversal, closing everything a second time', async () => {
    const { order, smallInvoice, bigInvoice } = await fullyBilledOrder();

    await payInFull(smallInvoice);
    const { paymentId } = await payInFull(bigInvoice);
    await failPayment(bigInvoice, paymentId, 'Bank returned the first attempt').expect(200);

    // Pay it properly the second time.
    await payInFull(bigInvoice);

    expect(
      (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } })).status,
    ).toBe('CLOSED');
    expect((await prisma.tender.findUniqueOrThrow({ where: { id: order.tenderId } })).status).toBe(
      'CLOSED',
    );

    // Two payments exist against that invoice: one failed, one completed. The
    // failed one was never edited away.
    const payments = await prisma.payment.findMany({
      where: { invoiceId: bigInvoice.invoiceId },
      orderBy: { createdAt: 'asc' },
    });
    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.status).sort()).toEqual(['COMPLETED', 'FAILED']);
  });
});
