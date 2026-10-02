import request from 'supertest';
import { expect } from 'vitest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { acceptLine, acceptedOrder, receive, type AcceptedOrder } from './fulfilment.js';

/**
 * An invoice sitting at `APPROVED_FOR_PAYMENT`, reached the whole way through:
 * tender, bids, award, purchase order, acceptance, goods receipt, vendor
 * invoice, three-way match, approval.
 *
 * Nine HTTP calls deep and deliberately so — a payment is only meaningful
 * against an invoice that earned its way to payable, and plan 13's rules are
 * about exactly that chain.
 */

let invoiceSeq = 0;
const nextInvoiceNumber = () => `VINV-${Date.now()}-${++invoiceSeq}`;

export interface PayableInvoice {
  order: AcceptedOrder;
  invoiceId: string;
  /** Line 2 of the order: 24 units of the cheaper item. */
  lineId: string;
  totalAmount: string;
}

/**
 * `quantity` units of line 2 are received, invoiced and approved.
 *
 * Line 2 is used because it is cheap enough that one or two units stay under the
 * 50,000 default approval threshold, so the invoice clears inline and the test
 * is about payment rather than about approval routing.
 */
export async function payableInvoice(quantity = '1.000'): Promise<PayableInvoice> {
  const order = await acceptedOrder();
  const lineId = order.items[1]!.id;

  await receive(order, [acceptLine(lineId, quantity)]).expect(201);

  const poItem = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: lineId } });

  const draft = await request(app)
    .post(`/api/v1/vendor/purchase-orders/${order.poId}/invoices`)
    .set(...order.f.vendors[0]!.contact.authHeader)
    .send({
      vendorInvoiceNumber: nextInvoiceNumber(),
      invoiceDate: new Date().toISOString(),
      items: [
        { purchaseOrderItemId: lineId, quantity, unitPrice: poItem.unitPrice.toFixed(2) },
      ],
    });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);

  const submitted = await request(app)
    .post(`/api/v1/vendor/invoices/${draft.body.data.id}/submit`)
    .set(...order.f.vendors[0]!.contact.authHeader);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  expect(submitted.body.data.matchStatus, 'the fixture invoice must match cleanly').toBe('MATCHED');

  const approved = await request(app)
    .post(`/api/v1/invoices/${draft.body.data.id}/approve`)
    .set(...order.f.admin.authHeader)
    .send({});
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(approved.body.data.status).toBe('APPROVED_FOR_PAYMENT');

  return {
    order,
    invoiceId: draft.body.data.id,
    lineId,
    totalAmount: approved.body.data.totalAmount,
  };
}

/** Give the vendor a bank account, which NEFT and friends require. */
export async function withBankDetails(payable: PayableInvoice) {
  await prisma.vendor.update({
    where: { id: payable.order.f.vendors[0]!.vendor.id },
    data: { bankAccountNumber: '123456784821', bankIfsc: 'SBIN0001234', bankName: 'State Bank' },
  });
  return payable;
}

export const recordPayment = (
  payable: PayableInvoice,
  body: Record<string, unknown>,
  actor: 'admin' | 'officer' | 'approver' = 'admin',
) =>
  request(app)
    .post('/api/v1/payments')
    .set(...payable.order.f[actor].authHeader)
    .send({
      invoiceId: payable.invoiceId,
      method: 'NEFT',
      paidAt: new Date().toISOString(),
      ...body,
    });

export const completePayment = (
  payable: PayableInvoice,
  paymentId: string,
  referenceNumber = `SBIN${Date.now()}`,
) =>
  request(app)
    .post(`/api/v1/payments/${paymentId}/complete`)
    .set(...payable.order.f.admin.authHeader)
    .send({ referenceNumber });

export const failPayment = (payable: PayableInvoice, paymentId: string, reason: string) =>
  request(app)
    .post(`/api/v1/payments/${paymentId}/fail`)
    .set(...payable.order.f.admin.authHeader)
    .send({ reason });

/** Record and complete in one step, for tests about what happens afterwards. */
export async function payInFull(payable: PayableInvoice, overrides: Record<string, unknown> = {}) {
  const recorded = await recordPayment(payable, {
    grossAmount: payable.totalAmount,
    ...overrides,
  });
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);

  const completed = await completePayment(payable, recorded.body.data.id);
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);

  return { paymentId: recorded.body.data.id, recorded, completed };
}

export const invoiceOf = (invoiceId: string) =>
  prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
