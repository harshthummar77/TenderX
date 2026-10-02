import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { acceptLine, acceptedOrder, receive, type AcceptedOrder } from './helpers/fulfilment.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Vendor-raised invoices and the three-way match, end to end.
 *
 * Every test runs tender → bids → award → PO → acceptance → goods receipt before
 * it can invoice anything, which is the point: the match is only meaningful
 * against quantities a real GRN wrote.
 */
vi.setConfig({ testTimeout: 180_000 });

const vendorAuth = (order: AcceptedOrder, index = 0) =>
  order.f.vendors[index]!.contact.authHeader;

let invoiceSeq = 0;
const nextInvoiceNumber = () => `VINV-${Date.now()}-${++invoiceSeq}`;

/** An accepted order with 7 of line 1's 12 units received and accepted. */
async function orderWithReceipt(accepted = '7.000') {
  const order = await acceptedOrder();
  await receive(order, [acceptLine(order.items[0]!.id, accepted)]).expect(201);
  return order;
}

const invoiceable = (order: AcceptedOrder) =>
  request(app)
    .get(`/api/v1/vendor/purchase-orders/${order.poId}/invoiceable`)
    .set(...vendorAuth(order));

const draftInvoice = (
  order: AcceptedOrder,
  items: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) =>
  request(app)
    .post(`/api/v1/vendor/purchase-orders/${order.poId}/invoices`)
    .set(...vendorAuth(order))
    .send({
      vendorInvoiceNumber: nextInvoiceNumber(),
      invoiceDate: new Date().toISOString(),
      items,
      ...overrides,
    });

const submit = (order: AcceptedOrder, invoiceId: string) =>
  request(app)
    .post(`/api/v1/vendor/invoices/${invoiceId}/submit`)
    .set(...vendorAuth(order));

/** Price a line at the order's own unit price, which is what should match. */
async function poPriceOf(purchaseOrderItemId: string) {
  const item = await prisma.purchaseOrderItem.findUniqueOrThrow({
    where: { id: purchaseOrderItemId },
  });
  return item.unitPrice.toFixed(2);
}

/** Draft and submit in one step, returning the submitted invoice body. */
async function submitInvoice(
  order: AcceptedOrder,
  items: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
  const draft = await draftInvoice(order, items, overrides);
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);

  const submitted = await submit(order, draft.body.data.id);
  return { draft: draft.body.data, submitted };
}

const checkOf = (body: Record<string, unknown>, code: string) =>
  (body.matchResult as { code: string }[]).find((c) => c.code === code) as
    | { code: string; status: string; expected?: string; actual?: string; variance?: string }
    | undefined;

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Invoiceable prefill                                                        */
/* -------------------------------------------------------------------------- */

describe('invoiceable prefill', () => {
  it('offers exactly what was accepted and warns about the rest', async () => {
    const order = await orderWithReceipt('7.000');

    const res = await invoiceable(order);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.canInvoice).toBe(true);

    const line = res.body.data.lines.find(
      (l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === order.items[0]!.id,
    );
    expect(line.ordered).toBe('12.000');
    expect(line.accepted).toBe('7.000');
    expect(line.alreadyInvoiced).toBe('0.000');
    expect(line.invoiceable).toBe('7.000');

    // 5 of line 1 plus all 24 of line 2 are still undelivered.
    expect(res.body.data.warnings.join(' ')).toMatch(/29\.000 units ordered are not yet received/);
  });

  it('offers nothing before any goods are accepted', async () => {
    const order = await acceptedOrder();

    const res = await invoiceable(order);
    expect(res.body.data.canInvoice).toBe(false);
    expect(res.body.data.warnings.join(' ')).toMatch(/Nothing is invoiceable yet/);
  });

  it('warns that rejected goods cannot be invoiced', async () => {
    const order = await acceptedOrder();
    await receive(order, [
      {
        purchaseOrderItemId: order.items[0]!.id,
        receivedQuantity: '8.000',
        acceptedQuantity: '7.000',
        rejectedQuantity: '1.000',
        rejectionReason: 'Physical damage to chassis, unit 3',
      },
    ]).expect(201);

    const res = await invoiceable(order);
    expect(res.body.data.warnings.join(' ')).toMatch(/1\.000 units were received but rejected/);
  });

  it('is not visible to another vendor', async () => {
    const order = await orderWithReceipt();

    await request(app)
      .get(`/api/v1/vendor/purchase-orders/${order.poId}/invoiceable`)
      .set(...vendorAuth(order, 1))
      .expect(404);
  });
});

/* -------------------------------------------------------------------------- */
/* The match, over HTTP                                                       */
/* -------------------------------------------------------------------------- */

describe('three-way match', () => {
  /** Plan 12 §12 — the accepted quantity at the order price matches cleanly. */
  it('matches an invoice for exactly what was accepted at the order price', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);

    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);

    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.status).toBe('UNDER_REVIEW');
    expect(submitted.body.data.matchStatus).toBe('MATCHED');

    for (const check of submitted.body.data.matchResult) {
      expect(check.status, `${check.code}`).toBe('PASS');
    }

    // The quantity is now claimed against the line.
    const line = await prisma.purchaseOrderItem.findUniqueOrThrow({
      where: { id: order.items[0]!.id },
    });
    expect(line.invoicedQuantity.toFixed(3)).toBe('7.000');
  });

  /** Plan 12 §12 — 12 invoiced when 7 were accepted. */
  it('excepts an over-quantity invoice with the variance spelled out', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);

    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '12.000', unitPrice: price },
    ]);

    expect(submitted.status).toBe(200);
    expect(submitted.body.data.matchStatus).toBe('EXCEPTION');

    const quantity = checkOf(submitted.body.data, 'quantity')!;
    expect(quantity.status).toBe('FAIL');
    expect(quantity.expected).toBe('7.000');
    expect(quantity.actual).toBe('12.000');
    expect(quantity.variance).toBe('5.000');

    const exception = await prisma.notification.count({
      where: { type: 'INVOICE_MATCH_EXCEPTION' },
    });
    expect(exception).toBeGreaterThan(0);
  });

  /** Plan 12 §12 — 1.5% over a 2% tolerance warns but still matches. */
  it('warns on a price inside the tolerance and still matches', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const dearer = (Number(price) * 1.015).toFixed(2);

    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: dearer },
    ]);

    expect(submitted.body.data.matchStatus).toBe('MATCHED');
    expect(checkOf(submitted.body.data, 'price')!.status).toBe('WARN');
  });

  /** Plan 12 §12 — 3% over fails. */
  it('excepts a price beyond the tolerance', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const dearer = (Number(price) * 1.03).toFixed(2);

    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: dearer },
    ]);

    expect(submitted.body.data.matchStatus).toBe('EXCEPTION');
    expect(checkOf(submitted.body.data, 'price')!.status).toBe('FAIL');
  });

  /** Plan 12 §12 — a clean 422, not a raw Prisma unique-constraint error. */
  it('refuses a duplicate invoice number with a business error', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const number = nextInvoiceNumber();

    await draftInvoice(
      order,
      [{ purchaseOrderItemId: order.items[0]!.id, quantity: '3.000', unitPrice: price }],
      { vendorInvoiceNumber: number },
    ).expect(201);

    const second = await draftInvoice(
      order,
      [{ purchaseOrderItemId: order.items[0]!.id, quantity: '2.000', unitPrice: price }],
      { vendorInvoiceNumber: number },
    );

    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('invoice.duplicate_number');
  });

  it('refuses an invoice dated before the order was issued', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);

    const res = await draftInvoice(
      order,
      [{ purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price }],
      { invoiceDate: new Date(Date.now() - 365 * 86_400_000).toISOString() },
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invoice.invalid_date');
  });

  /** Plan 12 §12 — the GRN requirement, then rematch once it is satisfied. */
  it('blocks submission with no GRN, then rematches clean once one exists', async () => {
    const order = await acceptedOrder();
    const price = await poPriceOf(order.items[0]!.id);

    // requireGrnBeforeInvoice defaults to true, and nothing has been receipted.
    const blocked = await draftInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);
    expect(blocked.status).toBe(201);

    const refused = await submit(order, blocked.body.data.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('invoice.grn_required');

    // The goods turn up and are receipted.
    await receive(order, [acceptLine(order.items[0]!.id, '7.000')]).expect(201);

    const accepted = await submit(order, blocked.body.data.id);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data.matchStatus).toBe('MATCHED');
  });

  it('rematches an exception into a match when the missing GRN arrives', async () => {
    const order = await orderWithReceipt('3.000');
    const price = await poPriceOf(order.items[0]!.id);

    // Billing 7 when only 3 were accepted.
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);
    expect(submitted.body.data.matchStatus).toBe('EXCEPTION');

    // The remaining 4 arrive and are accepted.
    await receive(order, [acceptLine(order.items[0]!.id, '4.000')]).expect(201);

    const rematched = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/rematch`)
      .set(...order.f.officer.authHeader);

    expect(rematched.status, JSON.stringify(rematched.body)).toBe(200);
    expect(rematched.body.data.matchStatus).toBe('MATCHED');
  });

  it('does not fail an invoice against its own claimed quantity on rematch', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);

    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);
    expect(submitted.body.data.matchStatus).toBe('MATCHED');

    const again = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/rematch`)
      .set(...order.f.officer.authHeader);

    expect(again.body.data.matchStatus).toBe('MATCHED');
  });
});

/* -------------------------------------------------------------------------- */
/* Approve, reject, override                                                  */
/* -------------------------------------------------------------------------- */

describe('approval', () => {
  /** One line of the cheaper item, so the total stays under the 50,000 threshold. */
  it('approves a matched invoice inline and tells the vendor', async () => {
    const order = await acceptedOrder();
    await receive(order, [acceptLine(order.items[1]!.id, '1.000')]).expect(201);
    const price = await poPriceOf(order.items[1]!.id);

    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[1]!.id, quantity: '1.000', unitPrice: price },
    ]);
    expect(submitted.body.data.matchStatus).toBe('MATCHED');

    const approved = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/approve`)
      .set(...order.f.admin.authHeader)
      .send({ comment: 'Verified against the receipt.' });

    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED_FOR_PAYMENT');
    // The payable guard now lets plan 13 pay it.
    expect(approved.body.data.payableBlocker).toBeNull();

    const told = await prisma.notification.count({ where: { type: 'INVOICE_APPROVED' } });
    expect(told).toBeGreaterThan(0);
  });

  /** Plan 12 §12 — an exception cannot be approved. */
  it('refuses to approve an invoice with an open exception', async () => {
    const order = await orderWithReceipt('3.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);
    expect(submitted.body.data.matchStatus).toBe('EXCEPTION');

    const res = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/approve`)
      .set(...order.f.admin.authHeader)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invoice.match_exception');
  });

  /** Plan 12 §12 — an officer holds neither INVOICE_APPROVE nor INVOICE_OVERRIDE. */
  it('is withheld from an officer by the role matrix', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);

    await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/approve`)
      .set(...order.f.officer.authHeader)
      .send({})
      .expect(403);

    await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/override-match`)
      .set(...order.f.officer.authHeader)
      .send({ reason: 'An officer should not be able to do this at all, ever.' })
      .expect(403);
  });

  /** Above the threshold it escalates rather than clearing inline (plan 12 §7). */
  it('raises an approval request for a high-value invoice', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);
    expect(submitted.body.data.matchStatus).toBe('MATCHED');

    const res = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/approve`)
      .set(...order.f.admin.authHeader)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Still under review: it is waiting for a second person.
    expect(res.body.data.status).toBe('UNDER_REVIEW');

    const approval = await prisma.approval.findFirstOrThrow({
      where: { entityType: 'INVOICE', entityId: submitted.body.data.id },
    });
    expect(approval.status).toBe('PENDING');

    // And the other admin can decide it through plan 09's engine.
    const decided = await request(app)
      .post(`/api/v1/approvals/${approval.id}/decide`)
      .set(...order.f.approver.authHeader)
      .send({ decision: 'APPROVED', comment: 'Checked the receipt and the match.' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const settled = await prisma.invoice.findUniqueOrThrow({
      where: { id: submitted.body.data.id },
    });
    expect(settled.status).toBe('APPROVED_FOR_PAYMENT');
  });
});

describe('rejection', () => {
  /** Plan 12 §12 — rejecting restores the invoiceable quantity. */
  it('releases the claimed quantity so the vendor can resubmit', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);

    const claimed = await prisma.purchaseOrderItem.findUniqueOrThrow({
      where: { id: order.items[0]!.id },
    });
    expect(claimed.invoicedQuantity.toFixed(3)).toBe('7.000');

    const rejected = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/reject`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'The HSN code on line 1 does not match the goods supplied.' });

    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data.status).toBe('REJECTED');

    // The quantity is available again.
    const released = await prisma.purchaseOrderItem.findUniqueOrThrow({
      where: { id: order.items[0]!.id },
    });
    expect(released.invoicedQuantity.toFixed(3)).toBe('0.000');

    const prefill = await invoiceable(order);
    const line = prefill.body.data.lines.find(
      (l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === order.items[0]!.id,
    );
    expect(line.invoiceable).toBe('7.000');
  });

  it('demands a reason of at least 20 characters', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);

    const res = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/reject`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'No' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  /** A rejected invoice is corrected and resubmitted, not recreated. */
  it('lets the vendor correct and resubmit the same invoice', async () => {
    const order = await orderWithReceipt('3.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);

    await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/reject`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'You billed 7 units but only 3 were accepted on receipt.' })
      .expect(200);

    // Correct it down to what was actually accepted.
    const corrected = await request(app)
      .patch(`/api/v1/vendor/invoices/${submitted.body.data.id}`)
      .set(...vendorAuth(order))
      .send({
        items: [{ purchaseOrderItemId: order.items[0]!.id, quantity: '3.000', unitPrice: price }],
      });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);

    const resubmitted = await submit(order, submitted.body.data.id);
    expect(resubmitted.status, JSON.stringify(resubmitted.body)).toBe(200);
    // Corrected to the accepted quantity, so it matches this time.
    expect(resubmitted.body.data.matchStatus).toBe('MATCHED');

    // Both attempts are on the record.
    const actions = (
      await prisma.activityLog.findMany({
        where: { entityType: 'Invoice', entityId: submitted.body.data.id },
        orderBy: { sequence: 'asc' },
        select: { action: true },
      })
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['invoice.submitted', 'invoice.rejected', 'invoice.resubmitted']),
    );
  });
});

describe('override', () => {
  /** Plan 12 §12 — a price exception may be overridden, attributably. */
  it('overrides a price exception and records it at SECURITY', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const dearer = (Number(price) * 1.03).toFixed(2);

    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: dearer },
    ]);
    expect(submitted.body.data.matchStatus).toBe('EXCEPTION');

    const res = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/override-match`)
      .set(...order.f.admin.authHeader)
      .send({
        reason: 'Freight surcharge agreed by email on 14 March; difference is immaterial.',
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.matchStatus).toBe('OVERRIDDEN');
    expect(res.body.data.overrideReason).toMatch(/Freight surcharge/);

    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'invoice.match_overridden', entityId: submitted.body.data.id },
    });
    expect(entry.severity).toBe('SECURITY');

    // It stays on the report an auditor reads.
    const report = await request(app)
      .get('/api/v1/invoices/match-exceptions')
      .set(...order.f.admin.authHeader);
    expect(report.status).toBe(200);
    expect(
      report.body.data.map((row: { id: string }) => row.id),
    ).toContain(submitted.body.data.id);

    // And now it can be approved.
    const approved = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/approve`)
      .set(...order.f.admin.authHeader)
      .send({});
    expect([200]).toContain(approved.status);
  });

  /** Plan 12 §12 — the one exception class that can never be waved through. */
  it('refuses to override a quantity exception', async () => {
    const order = await orderWithReceipt('3.000');
    const price = await poPriceOf(order.items[0]!.id);

    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);
    expect(submitted.body.data.matchStatus).toBe('EXCEPTION');

    const res = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/override-match`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'We would like to pay for goods that never arrived, please.' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invoice.quantity_not_overridable');
  });

  it('demands a reason of at least 30 characters', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const dearer = (Number(price) * 1.03).toFixed(2);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: dearer },
    ]);

    const res = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/override-match`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'Close enough' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('has nothing to override on a matched invoice', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);

    const res = await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/override-match`)
      .set(...order.f.admin.authHeader)
      .send({ reason: 'There is no exception here to override at all, really.' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invoice.nothing_to_override');
  });
});

/* -------------------------------------------------------------------------- */
/* Ageing and isolation                                                       */
/* -------------------------------------------------------------------------- */

describe('AP ageing', () => {
  it('buckets an approved invoice and reports it per vendor', async () => {
    const order = await acceptedOrder();
    await receive(order, [acceptLine(order.items[1]!.id, '1.000')]).expect(201);
    const price = await poPriceOf(order.items[1]!.id);

    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[1]!.id, quantity: '1.000', unitPrice: price },
    ]);
    await request(app)
      .post(`/api/v1/invoices/${submitted.body.data.id}/approve`)
      .set(...order.f.admin.authHeader)
      .send({})
      .expect(200);

    const res = await request(app)
      .get('/api/v1/invoices/ageing')
      .set(...order.f.admin.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.total.count).toBe(1);
    // Due in 30 days by default, so it is not yet overdue.
    const notDue = res.body.data.buckets.find((b: { label: string }) => b.label === 'Not due');
    expect(notDue.count).toBe(1);
    expect(res.body.data.byVendor[0].name).toBe(order.f.vendors[0]!.vendor.companyName);
  });

  it('counts nothing that is not approved', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);

    const res = await request(app)
      .get('/api/v1/invoices/ageing')
      .set(...order.f.admin.authHeader);

    // UNDER_REVIEW is not a liability yet.
    expect(res.body.data.total.count).toBe(0);
    expect(res.body.data.total.amount).toBe('0.00');
  });
});

describe('isolation', () => {
  it('hides an invoice from another vendor and another organization', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);
    const id = submitted.body.data.id;

    await request(app)
      .get(`/api/v1/vendor/invoices/${id}`)
      .set(...vendorAuth(order, 1))
      .expect(404);

    const rival = await acceptedOrder();
    await request(app)
      .get(`/api/v1/invoices/${id}`)
      .set(...rival.f.admin.authHeader)
      .expect(404);
  });

  it('lets the vendor see the full match checklist on their own invoice', async () => {
    const order = await orderWithReceipt('3.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);

    const mine = await request(app)
      .get(`/api/v1/vendor/invoices/${submitted.body.data.id}`)
      .set(...vendorAuth(order));

    expect(mine.status).toBe(200);
    // A vendor told only "rejected" cannot fix it; the checklist is the fix list.
    expect(checkOf(mine.body.data, 'quantity')!.status).toBe('FAIL');
  });
});

describe('PDF', () => {
  it('serves a tax invoice PDF to both parties', async () => {
    const order = await orderWithReceipt('7.000');
    const price = await poPriceOf(order.items[0]!.id);
    const { submitted } = await submitInvoice(order, [
      { purchaseOrderItemId: order.items[0]!.id, quantity: '7.000', unitPrice: price },
    ]);

    const res = await request(app)
      .get(`/api/v1/invoices/${submitted.body.data.id}/pdf`)
      .set(...order.f.admin.authHeader)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});
