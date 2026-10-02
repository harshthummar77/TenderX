import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { money } from '../src/lib/money.js';
import { PurchaseOrderPdf } from '../src/lib/pdf/PurchaseOrderPdf.js';
import { renderPdf } from '../src/lib/pdf/renderer.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { toPurchaseOrderDto } from '../src/modules/purchase-order/po.serializers.js';
import { recomputeFulfilment } from '../src/modules/purchase-order/fulfilment.service.js';
import { makeUser } from './helpers/actors.js';
import { openedForEvaluation, type BidFixture } from './helpers/bidding.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Purchase orders, end to end from an approved award. Each test runs a whole
 * tender lifecycle plus an approval over the Neon test branch, so this file
 * needs the same headroom as the other integration suites.
 */
vi.setConfig({ testTimeout: 150_000 });

const JUSTIFICATION =
  'Lowest evaluated cost with the shortest delivery window, and the vendor has completed prior networking orders on time.';

/** A tender awarded through the real approval path, which generates the PO. */
async function awarded(prices?: string[][]) {
  const { f, tender, bids } = await openedForEvaluation(prices);

  await request(app)
    .post(`/api/v1/tenders/${tender.id}/recommend`)
    .set(...f.officer.authHeader)
    .send({ quotationId: bids[0]!.id, justification: JUSTIFICATION })
    .expect(200);

  const approval = await prisma.approval.findFirstOrThrow({ where: { entityId: tender.id } });

  await request(app)
    .post(`/api/v1/approvals/${approval.id}/decide`)
    .set(...f.admin.authHeader)
    .send({ decision: 'APPROVED', comment: 'Approved. Confirm the warranty in the PO terms.' })
    .expect(200);

  const po = await prisma.purchaseOrder.findFirstOrThrow({
    where: { tenderId: tender.id },
    include: { items: { orderBy: { srNo: 'asc' } } },
  });

  return { f, tender, bids, approval, po };
}

/** Give the buyer org and the vendor a GSTIN in the same or a different state. */
async function setStates(f: BidFixture, orgStateCode: string, vendorStateCode: string) {
  await prisma.organization.update({
    where: { id: f.org.id },
    data: { stateCode: orgStateCode, gstin: `${orgStateCode}AABCU9603R1ZM` },
  });
  await prisma.vendor.update({
    where: { id: f.vendors[0]!.vendor.id },
    data: { stateCode: vendorStateCode, gstin: `${vendorStateCode}AABCU9603R1ZX` },
  });
  clearOrgCache();
  clearVendorCache();
}

const issue = (f: BidFixture, poId: string) =>
  request(app)
    .post(`/api/v1/purchase-orders/${poId}/issue`)
    .set(...f.admin.authHeader);

const vendorAuth = (f: BidFixture, index = 0) => f.vendors[index]!.contact.authHeader;

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Generation from an award                                                   */
/* -------------------------------------------------------------------------- */

describe('generation from an award', () => {
  /** Plan 10 §11 — exactly one PO, in DRAFT, and the tender is AWARDED. */
  it('creates exactly one DRAFT purchase order inside the approval', async () => {
    const { tender, bids, po } = await awarded();

    const all = await prisma.purchaseOrder.findMany({ where: { tenderId: tender.id } });
    expect(all).toHaveLength(1);

    expect(po.status).toBe('DRAFT');
    expect(po.fulfilmentStatus).toBe('NOT_STARTED');
    expect(po.poNumber).toMatch(/^PO\/\d{4}-\d{2}\/\d{6}$/);
    expect(po.quotationId).toBe(bids[0]!.id);
    expect(po.items).toHaveLength(2);

    const row = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(row.status).toBe('AWARDED');
    expect(row.awardedQuotationId).toBe(bids[0]!.id);
  });

  it('carries the winning bid amounts onto the order', async () => {
    const { bids, po } = await awarded();
    const bid = await prisma.quotation.findUniqueOrThrow({ where: { id: bids[0]!.id } });

    // Same taxable base; the total is the GST engine's whole-rupee figure.
    expect(po.taxableAmount.toFixed(2)).toBe(bid.taxableAmount.toFixed(2));
    expect(po.totalAmount.modulo(1).isZero()).toBe(true);
    expect(po.roundOff.abs().lessThanOrEqualTo('0.50')).toBe(true);
  });

  /**
   * Plan 10 §2 — the single most important modelling decision in the module. A
   * purchase order is a contract: moving office next month must not rewrite the
   * address it was issued to, nor the state code that decided its tax.
   */
  it('freezes the party snapshot against later changes', async () => {
    const { f, po } = await awarded();

    await prisma.vendor.update({
      where: { id: f.vendors[0]!.vendor.id },
      data: {
        companyName: 'Acme Networks (Relocated) Pvt Ltd',
        addressLine1: '99 New Industrial Park',
        city: 'Pune',
        state: 'Maharashtra',
        stateCode: '27',
      },
    });
    clearVendorCache();

    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });

    expect(after.vendorName).toBe('Acme Networks');
    expect(after.vendorAddress).toContain('Surat');
    expect(after.vendorStateCode).toBe(po.vendorStateCode);
    // And above all, the regime did not move with them.
    expect(after.taxRegime).toBe(po.taxRegime);
  });

  /** Plan 10 §11 — Gujarat vendor, Gujarat delivery. */
  it('charges CGST and SGST when the supply stays in state', async () => {
    const { f } = await openedForEvaluation();
    await setStates(f, '24', '24');
    const { po } = await awardedFrom(f);

    expect(po.taxRegime).toBe('INTRA_STATE');
    expect(po.igstAmount.toFixed(2)).toBe('0.00');
    expect(po.cgstAmount.toFixed(2)).toBe(po.sgstAmount.toFixed(2));
    expect(money(po.cgstAmount).plus(po.sgstAmount).toFixed(2)).toBe(
      money(po.taxableAmount).mul('0.18').toDecimalPlaces(2).toFixed(2),
    );
  });

  /** Plan 10 §11 — the delivery state is what makes it inter-state. */
  it('charges IGST when the goods cross a state border', async () => {
    const { f } = await openedForEvaluation(undefined, { deliveryStateCode: '27' });
    await setStates(f, '24', '24');
    const { po } = await awardedFrom(f);

    expect(po.placeOfSupplyStateCode).toBe('27');
    expect(po.taxRegime).toBe('INTER_STATE');
    expect(po.cgstAmount.toFixed(2)).toBe('0.00');
    expect(po.sgstAmount.toFixed(2)).toBe('0.00');
    expect(po.igstAmount.greaterThan(0)).toBe(true);
  });

  /** Plan 10 §11 — an unregistered supplier charges nothing. */
  it('is EXEMPT with zero tax when the vendor has no GSTIN', async () => {
    const { po } = await awarded();

    // The fixture vendors carry no GSTIN at all.
    expect(po.vendorGstin).toBeNull();
    expect(po.taxRegime).toBe('EXEMPT');
    expect(po.cgstAmount.toFixed(2)).toBe('0.00');
    expect(po.sgstAmount.toFixed(2)).toBe('0.00');
    expect(po.igstAmount.toFixed(2)).toBe('0.00');
    for (const item of po.items) {
      expect(item.cgstAmount.toFixed(2)).toBe('0.00');
      expect(item.igstAmount.toFixed(2)).toBe('0.00');
    }
  });
});

/** Award an already-opened tender, for tests that set party state first. */
async function awardedFrom(f: BidFixture) {
  const tender = await prisma.tender.findFirstOrThrow({
    where: { organizationId: f.org.id, status: 'UNDER_EVALUATION' },
  });
  const bids = await prisma.quotation.findMany({
    where: { tenderId: tender.id, status: 'SUBMITTED' },
    orderBy: { grandTotal: 'asc' },
  });

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
  return { tender, bids, po };
}

/* -------------------------------------------------------------------------- */
/* Issue                                                                      */
/* -------------------------------------------------------------------------- */

describe('issuing', () => {
  it('moves DRAFT to ISSUED and tells the vendor the amount', async () => {
    const { f, po } = await awarded();

    const res = await issue(f, po.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('ISSUED');
    expect(res.body.data.issuedAt).toBeTruthy();

    const notified = await prisma.notification.findFirstOrThrow({
      where: { type: 'PO_ISSUED', entityId: po.id },
    });
    // The seal is over and the vendor quoted this figure themselves.
    expect(notified.body).toContain(po.totalAmount.toFixed(2));
  });

  /** Plan 10 §11 — two concurrent issues, one ISSUED order. */
  it('turns two concurrent issues into one order and one 422', async () => {
    const { f, po } = await awarded();

    const [first, second] = await Promise.all([issue(f, po.id), issue(f, po.id)]);

    expect([first.status, second.status].sort()).toEqual([200, 422]);
    const loser = first.status === 422 ? first : second;
    expect(loser.body.error.code).toBe('po.invalid_transition');

    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(row.status).toBe('ISSUED');
  });

  it('refuses to issue to a blacklisted vendor', async () => {
    const { f, po } = await awarded();
    await prisma.vendor.update({
      where: { id: f.vendors[0]!.vendor.id },
      data: { status: 'BLACKLISTED', statusReason: 'Repeated quality failures' },
    });
    clearVendorCache();

    const res = await issue(f, po.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('po.vendor_not_permitted');
  });

  it('is withheld from an officer by the role matrix', async () => {
    const { f, po } = await awarded();

    const res = await request(app)
      .post(`/api/v1/purchase-orders/${po.id}/issue`)
      .set(...f.officer.authHeader);

    expect(res.status).toBe(403);
  });

  it('keeps a draft order out of the vendor list until it is issued', async () => {
    const { f, po } = await awarded();

    const before = await request(app)
      .get('/api/v1/vendor/purchase-orders')
      .set(...vendorAuth(f));
    expect(before.body.data).toHaveLength(0);

    await issue(f, po.id).expect(200);

    const after = await request(app)
      .get('/api/v1/vendor/purchase-orders')
      .set(...vendorAuth(f));
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].poNumber).toBe(po.poNumber);
  });

  it("another vendor cannot read someone else's order", async () => {
    const { f, po } = await awarded();
    await issue(f, po.id).expect(200);

    await request(app)
      .get(`/api/v1/vendor/purchase-orders/${po.id}`)
      .set(...vendorAuth(f, 1))
      .expect(404);
  });
});

/* -------------------------------------------------------------------------- */
/* Vendor response                                                            */
/* -------------------------------------------------------------------------- */

describe('vendor response', () => {
  it('accepts an issued order and tells the buyer', async () => {
    const { f, po } = await awarded();
    await issue(f, po.id).expect(200);

    const res = await request(app)
      .post(`/api/v1/vendor/purchase-orders/${po.id}/accept`)
      .set(...vendorAuth(f))
      .send({ note: 'Confirmed, dispatch planned next week.' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('ACCEPTED');
    expect(res.body.data.acceptedAt).toBeTruthy();

    const notified = await prisma.notification.count({
      where: { type: 'PO_ACCEPTED', entityId: po.id },
    });
    expect(notified).toBeGreaterThan(0);
  });

  it('demands a reason of at least 20 characters to reject', async () => {
    const { f, po } = await awarded();
    await issue(f, po.id).expect(200);

    const res = await request(app)
      .post(`/api/v1/vendor/purchase-orders/${po.id}/reject`)
      .set(...vendorAuth(f))
      .send({ reason: 'No thanks' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  /** Plan 10 §11 — reject, amend, reissue, with both events on the record. */
  it('supports reject then amend-and-reissue', async () => {
    const { f, po } = await awarded();
    await issue(f, po.id).expect(200);

    const rejected = await request(app)
      .post(`/api/v1/vendor/purchase-orders/${po.id}/reject`)
      .set(...vendorAuth(f))
      .send({ reason: 'The delivery date falls inside our annual shutdown week.' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data.status).toBe('REJECTED');
    expect(rejected.body.data.rejectionReason).toMatch(/shutdown/);

    const amended = await request(app)
      .patch(`/api/v1/purchase-orders/${po.id}`)
      .set(...f.admin.authHeader)
      .send({ expectedDeliveryDate: new Date(Date.now() + 60 * 86_400_000).toISOString() });
    expect(amended.status, JSON.stringify(amended.body)).toBe(200);

    const reissued = await issue(f, po.id);
    expect(reissued.status, JSON.stringify(reissued.body)).toBe(200);
    expect(reissued.body.data.status).toBe('ISSUED');
    // Reissuing clears the previous rejection so the vendor sees a clean offer.
    expect(reissued.body.data.rejectionReason).toBeNull();

    // Both events are on the timeline.
    const actions = (
      await prisma.activityLog.findMany({
        where: { entityType: 'PurchaseOrder', entityId: po.id },
        orderBy: { sequence: 'asc' },
        select: { action: true },
      })
    ).map((row) => row.action);

    expect(actions).toEqual(
      expect.arrayContaining(['po.generated', 'po.issued', 'po.rejected', 'po.amended']),
    );
  });

  it('re-totals the order when an amendment changes the lines', async () => {
    const { f, po } = await awarded();

    const amended = await request(app)
      .patch(`/api/v1/purchase-orders/${po.id}`)
      .set(...f.admin.authHeader)
      .send({
        items: [
          {
            srNo: 1,
            description: 'Managed switch, L2+, PoE',
            unit: 'NOS',
            quantity: '2.000',
            unitPrice: '1000.00',
            taxRatePercent: '18.00',
          },
        ],
      });

    expect(amended.status, JSON.stringify(amended.body)).toBe(200);
    expect(amended.body.data.items).toHaveLength(1);
    expect(amended.body.data.taxableAmount).toBe('2000.00');
    // EXEMPT vendor, so no tax: the total is just the taxable value.
    expect(amended.body.data.totalAmount).toBe('2000.00');
  });

  it('refuses to amend an accepted order', async () => {
    const { f, po } = await awarded();
    await issue(f, po.id).expect(200);
    await request(app)
      .post(`/api/v1/vendor/purchase-orders/${po.id}/accept`)
      .set(...vendorAuth(f))
      .send({})
      .expect(200);

    const res = await request(app)
      .patch(`/api/v1/purchase-orders/${po.id}`)
      .set(...f.admin.authHeader)
      .send({ freightAmount: '100.00' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('po.not_editable');
  });
});

/* -------------------------------------------------------------------------- */
/* Cancel and re-award                                                        */
/* -------------------------------------------------------------------------- */

describe('cancellation', () => {
  /** Plan 10 §11 — the path when a winning vendor backs out. */
  it('lets the tender be re-awarded to the runner-up', async () => {
    const { f, tender, bids, po } = await awarded();
    await issue(f, po.id).expect(200);

    const res = await request(app)
      .post(`/api/v1/purchase-orders/${po.id}/cancel`)
      .set(...f.admin.authHeader)
      .send({ reason: 'Vendor has withdrawn from the contract' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');

    // The tender is back in evaluation with its award cleared...
    const reopened = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(reopened.status).toBe('UNDER_EVALUATION');
    expect(reopened.awardedQuotationId).toBeNull();
    expect(reopened.recommendedQuotationId).toBeNull();

    // ...the vendor who walked away cannot win again...
    const walked = await prisma.quotation.findUniqueOrThrow({ where: { id: bids[0]!.id } });
    expect(walked.status).toBe('REJECTED');

    // ...and the rest of the field is eligible once more.
    const pool = await prisma.quotation.findMany({
      where: { tenderId: tender.id, status: 'SUBMITTED' },
    });
    expect(pool).toHaveLength(2);

    // So the runner-up can be recommended and awarded.
    const again = await request(app)
      .post(`/api/v1/tenders/${tender.id}/recommend`)
      .set(...f.officer.authHeader)
      .send({
        quotationId: bids[1]!.id,
        justification: `${JUSTIFICATION} Re-awarded after the original winner withdrew.`,
      });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it('refuses to cancel once goods have been received', async () => {
    const { f, po } = await awarded();
    await issue(f, po.id).expect(200);

    // Plan 11 writes these; here it stands in for a delivery having arrived.
    await prisma.purchaseOrderItem.update({
      where: { id: po.items[0]!.id },
      data: { receivedQuantity: '1.000' },
    });

    const res = await request(app)
      .post(`/api/v1/purchase-orders/${po.id}/cancel`)
      .set(...f.admin.authHeader)
      .send({ reason: 'Changed our mind about the order' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('po.already_received');
  });
});

/* -------------------------------------------------------------------------- */
/* Fulfilment read model                                                      */
/* -------------------------------------------------------------------------- */

describe('fulfilment read model', () => {
  it('derives pendingDelivery and pendingInvoice per line', async () => {
    const { f, po } = await awarded();
    const [first] = po.items;

    await prisma.purchaseOrderItem.update({
      where: { id: first!.id },
      data: { receivedQuantity: '8.000', acceptedQuantity: '7.000', invoicedQuantity: '5.000' },
    });
    await prisma.$transaction((tx) => recomputeFulfilment(tx, po.id));

    const res = await request(app)
      .get(`/api/v1/purchase-orders/${po.id}/fulfilment`)
      .set(...f.admin.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.fulfilmentStatus).toBe('PARTIALLY_FULFILLED');

    const line = res.body.data.lines.find(
      (l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === first!.id,
    );
    expect(line.ordered).toBe('12.000');
    expect(line.received).toBe('8.000');
    expect(line.accepted).toBe('7.000');
    expect(line.rejected).toBe('1.000');
    expect(line.pendingDelivery).toBe('4.000'); // ordered - received
    expect(line.pendingInvoice).toBe('2.000'); // accepted - invoiced
    expect(line.status).toBe('PARTIAL');
  });

  it('reaches FULFILLED only when every line is fully received', async () => {
    const { po } = await awarded();

    for (const item of po.items) {
      await prisma.purchaseOrderItem.update({
        where: { id: item.id },
        data: { receivedQuantity: item.quantity },
      });
    }
    const updated = await prisma.$transaction((tx) => recomputeFulfilment(tx, po.id));

    expect(updated.fulfilmentStatus).toBe('FULFILLED');
  });

  /** `status` and `fulfilmentStatus` are different things (defect C2). */
  it('never lets fulfilment touch the contract status', async () => {
    const { f, po } = await awarded();
    await issue(f, po.id).expect(200);

    await prisma.purchaseOrderItem.updateMany({
      where: { purchaseOrderId: po.id },
      data: { receivedQuantity: '1.000' },
    });
    await prisma.$transaction((tx) => recomputeFulfilment(tx, po.id));

    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(row.status).toBe('ISSUED');
    expect(row.fulfilmentStatus).toBe('PARTIALLY_FULFILLED');
  });
});

/* -------------------------------------------------------------------------- */
/* Direct purchase orders                                                     */
/* -------------------------------------------------------------------------- */

describe('direct purchase orders', () => {
  const directBody = (vendorId: string, overrides: Record<string, unknown> = {}) => ({
    vendorId,
    placeOfSupplyStateCode: '24',
    deliveryAddress: 'Plot 12, GIDC Estate, Ahmedabad',
    expectedDeliveryDate: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    freightAmount: '0.00',
    justification: 'Routine replenishment of consumables below the tender threshold.',
    items: [
      {
        srNo: 1,
        description: 'Patch cords, Cat6, 2m',
        unit: 'NOS',
        quantity: '50.000',
        unitPrice: '120.00',
        taxRatePercent: '18.00',
      },
    ],
    ...overrides,
  });

  it('creates an order with no tender behind it', async () => {
    const { f } = await awarded();

    const res = await request(app)
      .post('/api/v1/purchase-orders')
      .set(...f.admin.authHeader)
      .send(directBody(f.vendors[1]!.vendor.id));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.tenderId).toBeNull();
    expect(res.body.data.quotationId).toBeNull();
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.taxableAmount).toBe('6000.00');

    // Skipping the tender is recorded at SECURITY with the justification.
    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'po.direct_created' },
    });
    expect(entry.severity).toBe('SECURITY');
    expect(JSON.stringify(entry.after)).toContain('Routine replenishment');
  });

  it('demands a justification of at least 30 characters', async () => {
    const { f } = await awarded();

    const res = await request(app)
      .post('/api/v1/purchase-orders')
      .set(...f.admin.authHeader)
      .send(directBody(f.vendors[1]!.vendor.id, { justification: 'Needed it' }));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('refuses an unapproved vendor', async () => {
    const { f } = await awarded();
    await prisma.vendor.update({
      where: { id: f.vendors[1]!.vendor.id },
      data: { status: 'SUSPENDED', statusReason: 'Under review' },
    });
    clearVendorCache();

    const res = await request(app)
      .post('/api/v1/purchase-orders')
      .set(...f.admin.authHeader)
      .send(directBody(f.vendors[1]!.vendor.id));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('po.vendor_not_approved');
  });

  /** The threshold is the control a direct order must not route around. */
  it('refuses an amount at or above the approval threshold', async () => {
    const { f } = await awarded();

    const res = await request(app)
      .post('/api/v1/purchase-orders')
      .set(...f.admin.authHeader)
      .send(
        directBody(f.vendors[1]!.vendor.id, {
          items: [
            {
              srNo: 1,
              description: 'Core switch chassis',
              unit: 'NOS',
              quantity: '1.000',
              unitPrice: '200000.00',
              taxRatePercent: '18.00',
            },
          ],
        }),
      );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('po.approval_required');
  });
});

/* -------------------------------------------------------------------------- */
/* PDF                                                                        */
/* -------------------------------------------------------------------------- */

describe('PDF', () => {
  it('serves a PDF for the buyer and the vendor', async () => {
    const { f, po } = await awarded();
    await issue(f, po.id).expect(200);

    for (const auth of [f.admin.authHeader, vendorAuth(f)]) {
      const res = await request(app)
        .get(`/api/v1/purchase-orders/${po.id}/pdf`)
        .set(...auth)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      // Every PDF starts with %PDF.
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      expect((res.body as Buffer).length).toBeGreaterThan(1000);
    }
  });

  /**
   * Plan 10 §11 — the words must match the figure, and the figure must be
   * grouped the Indian way. Checked on the DTO the document renders from, which
   * is where both strings are produced.
   */
  it('prints the amount in words matching the numeric total', async () => {
    const { po } = await awarded();
    const dto = toPurchaseOrderDto(po);

    expect(dto.totalAmountInWords).toMatch(/Rupees/);
    expect(dto.totalAmountInWords).toMatch(/Only$/);

    // EXEMPT vendor and a whole-rupee total, so there are no paise to print.
    expect(dto.totalAmountInWords).not.toMatch(/Paise/);

    // A ten-lakh-ish total must read in lakhs, not in thousands of thousands.
    if (money(dto.totalAmount).greaterThanOrEqualTo('100000')) {
      expect(dto.totalAmountInWords).toMatch(/Lakh/);
    }
  });

  it('renders without a tender behind it, and prints the exempt notice', async () => {
    const { po } = await awarded();
    const dto = toPurchaseOrderDto(po);

    expect(dto.taxRegime).toBe('EXEMPT');
    expect(dto.taxHeads).toEqual([]);

    const buffer = await renderPdf(PurchaseOrderPdf({ po: dto }));
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});

/* -------------------------------------------------------------------------- */
/* Isolation                                                                  */
/* -------------------------------------------------------------------------- */

describe('tenant isolation', () => {
  it('hides an order from another organization', async () => {
    const { po } = await awarded();
    const rivalOrg = await prisma.organization.create({
      data: {
        name: 'Rival Industries',
        email: `rival-${Date.now()}@example.test`,
        addressLine1: '2 Ring Road',
        city: 'Surat',
        state: 'Gujarat',
        stateCode: '24',
        pincode: '395001',
        status: 'ACTIVE',
      },
    });
    const rivalAdmin = await makeUser('ORG_ADMIN', { organizationId: rivalOrg.id });

    await request(app)
      .get(`/api/v1/purchase-orders/${po.id}`)
      .set(...rivalAdmin.authHeader)
      .expect(404);

    await request(app)
      .get(`/api/v1/purchase-orders/${po.id}/pdf`)
      .set(...rivalAdmin.authHeader)
      .expect(404);
  });
});
