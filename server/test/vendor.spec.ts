import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { gstinChecksum, PERMISSIONS as P } from '@tb/shared';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { authenticate } from '../src/middleware/authenticate.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { requestContext } from '../src/middleware/requestContext.js';
import { requirePermission } from '../src/middleware/requirePermission.js';
import {
  clearVendorCache,
  requireApprovedVendor,
  requireVendorCanFulfil,
  requireVendorNotRejected,
} from '../src/middleware/requireApprovedVendor.js';
import { makeOrganization, makeUser, makeVendor } from './helpers/actors.js';
import { disconnect, truncateAll } from './helpers/db.js';

const GSTIN_27 = '27AAPFU0939F1ZV';
const ACCOUNT = '50100123456789';

/**
 * GSTIN is unique in the database, so every fixture vendor needs its own — with
 * a real check digit, because the approval path validates it.
 */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let gstinSeed = 0;
function uniqueGstin(stateCode = '24'): { gstin: string; pan: string } {
  const index = gstinSeed++;
  const pan = `AAB${LETTERS[index % 26]}${LETTERS[(index / 26) % 26 | 0]}1234F`;
  const base = `${stateCode}${pan}1Z`;
  return { gstin: base + gstinChecksum(base), pan };
}

/**
 * Stand-ins for the vendor-facing business routes of plans 08–13, mounted with
 * the exact guard each will use. The §1 capability table is the module, so it
 * gets tested here rather than "when quotations land".
 */
function businessRoutes() {
  const a = express();
  a.use(express.json());
  a.use(requestContext);

  // New business: only an APPROVED vendor.
  a.post('/quotations', authenticate, requireApprovedVendor, requirePermission(P.QUOTATION_SUBMIT), (_req, res) =>
    res.status(201).json({ success: true, data: null }),
  );
  // Honouring an existing PO: APPROVED or SUSPENDED.
  a.post('/purchase-orders/accept', authenticate, requireVendorCanFulfil, requirePermission(P.PO_RESPOND), (_req, res) =>
    res.json({ success: true, data: null }),
  );
  // Money owed for work already done: anything but REJECTED.
  a.post('/invoices', authenticate, requireVendorNotRejected, requirePermission(P.INVOICE_SUBMIT), (_req, res) =>
    res.status(201).json({ success: true, data: null }),
  );

  a.use(errorHandler);
  return a;
}

async function makeCategory(name: string) {
  return prisma.category.create({
    data: { name, slug: name.toLowerCase().replace(/\s+/g, '-') },
  });
}

/** A vendor that satisfies every approval requirement. */
async function makeApprovableVendor(name: string, status: 'PENDING_APPROVAL' | 'APPROVED' = 'PENDING_APPROVAL') {
  const vendor = await makeVendor(name);
  const contact = await makeUser('VENDOR', { vendorId: vendor.id });
  const category = await makeCategory(`Category ${name}`);
  const { gstin, pan } = uniqueGstin('24');

  await prisma.vendor.update({
    where: { id: vendor.id },
    data: {
      status,
      gstin,
      pan,
      stateCode: '24',
      bankName: 'HDFC Bank',
      bankAccountName: name,
      bankAccountNumber: ACCOUNT,
      bankIfsc: 'HDFC0001234',
      categories: { connect: { id: category.id } },
    },
  });

  for (const type of ['VENDOR_GST_CERTIFICATE', 'VENDOR_PAN', 'VENDOR_CANCELLED_CHEQUE'] as const) {
    await prisma.document.create({
      data: {
        ownerType: 'VENDOR',
        ownerId: vendor.id,
        vendorId: vendor.id,
        type,
        fileName: `${type}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        storageKey: `${vendor.id}-${type}`,
        uploadedById: contact.user.id,
      },
    });
  }

  return {
    vendor: await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }),
    contact,
    category,
    gstin,
    pan,
  };
}

beforeEach(async () => {
  await truncateAll();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

describe('field-level visibility', () => {
  it('the public vendor DTO never leaks bank details', async () => {
    const { vendor, gstin: vendorGstin } = await makeApprovableVendor('Apex Components', 'APPROVED');
    const org = await makeOrganization('Buyer Ltd');
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });

    const res = await request(app).get(`/api/v1/vendors/${vendor.id}`).set(...officer.authHeader);
    expect(res.status).toBe(200);

    // Grep the whole serialised response: a field-by-field assertion misses a
    // leak through a nested relation.
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('bankAccountNumber');
    expect(json).not.toContain('bankIfsc');
    expect(json).not.toContain('bankName');
    expect(json).not.toContain(ACCOUNT);
    expect(json).not.toContain('statusReason');

    // ...while the public identifiers are present, as they should be.
    expect(res.body.data.gstin).toBe(vendorGstin);
    expect(res.body.data.companyName).toBe('Apex Components');
  });

  it('the directory listing leaks nothing either', async () => {
    await makeApprovableVendor('Listed Supplier', 'APPROVED');
    const org = await makeOrganization('Buyer Ltd');
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });

    const res = await request(app).get('/api/v1/vendors').set(...officer.authHeader);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(ACCOUNT);
  });

  it('the vendor sees its own bank details, masked', async () => {
    const { contact } = await makeApprovableVendor('Self Supplier', 'APPROVED');

    const res = await request(app).get('/api/v1/vendors/me').set(...contact.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.bankAccountNumber).toBe('XXXXXXXXXX6789');
    expect(res.body.data.bankAccountNumber).not.toContain('50100');
    expect(res.body.data.bankIfsc).toBe('HDFC0001234');
  });

  it('the platform admin view carries the KYC checklist and masked bank details', async () => {
    const { vendor } = await makeApprovableVendor('Reviewed Supplier');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .get(`/api/v1/platform/vendors/${vendor.id}`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.bankAccountNumber).toBe('XXXXXXXXXX6789');
    expect(JSON.stringify(res.body)).not.toContain(ACCOUNT);
    expect(res.body.data.missingKyc).toEqual([]);
    expect(res.body.data.documents).toHaveLength(3);
    expect(res.body.data.userCount).toBe(1);
  });
});

describe('KYC and approval', () => {
  it('returns every failure at once, not the first', async () => {
    const created = await makeVendor('Incomplete Supplier');
    // makeVendor seeds APPROVED for other suites; approval only applies to a
    // vendor that is actually awaiting it.
    const vendor = await prisma.vendor.update({
      where: { id: created.id },
      data: { status: 'PENDING_APPROVAL' },
    });
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .post(`/api/v1/platform/vendors/${vendor.id}/approve`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('vendor.incomplete_kyc');

    const paths = res.body.error.fields.map((f: { path: string }) => f.path);
    expect(paths).toContain('gstin');
    expect(paths).toContain('pan');
    expect(paths).toContain('contact');
    expect(paths).toContain('documents.gst');
    expect(paths).toContain('documents.pan');
    expect(paths).toContain('documents.cheque');
    expect(paths).toContain('categories');
    expect(paths.length).toBeGreaterThanOrEqual(7);
  });

  it('refuses a GSTIN whose state disagrees with the vendor state code', async () => {
    const { vendor } = await makeApprovableVendor('Mismatched Supplier');
    // Gujarat vendor carrying a Maharashtra GSTIN.
    await prisma.vendor.update({ where: { id: vendor.id }, data: { gstin: GSTIN_27 } });
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .post(`/api/v1/platform/vendors/${vendor.id}/approve`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(422);
    const gstinFailure = res.body.error.fields.find((f: { path: string }) => f.path === 'gstin');
    expect(gstinFailure.message).toMatch(/does not match the vendor state code/i);
  });

  it('rejects a state mismatch at write time too', async () => {
    const { vendor, contact, gstin: originalGstin } = await makeApprovableVendor('Editing Supplier');

    const res = await request(app)
      .patch('/api/v1/vendors/me')
      .set(...contact.authHeader)
      .send({ gstin: GSTIN_27 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('vendor.gstin_state_mismatch');

    const unchanged = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(unchanged.gstin).toBe(originalGstin);
  });

  it('approves a complete vendor, audits it and notifies the contact', async () => {
    const { vendor, contact } = await makeApprovableVendor('Complete Supplier');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .post(`/api/v1/platform/vendors/${vendor.id}/approve`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');

    const audit = await prisma.activityLog.findFirst({ where: { action: 'vendor.approved' } });
    expect(audit?.actorEmail).toBe(platformAdmin.user.email);

    const notification = await prisma.notification.findFirst({ where: { userId: contact.user.id } });
    expect(notification?.type).toBe('VENDOR_APPROVED');
  });

  it('surfaces duplicate PAN and bank account as warnings, not blocks', async () => {
    const first = await makeApprovableVendor('Original Supplier', 'APPROVED');
    const second = await makeVendor('Copycat Supplier');
    await prisma.vendor.update({
      where: { id: second.id },
      data: { pan: first.pan, bankAccountNumber: ACCOUNT },
    });
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .get(`/api/v1/platform/vendors/${second.id}`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(200);
    const kinds = res.body.data.duplicateWarnings.map((w: { kind: string }) => w.kind);
    expect(kinds).toContain('pan');
    expect(kinds).toContain('bank_account');
    expect(res.body.data.duplicateWarnings[0].vendorId).toBe(first.vendor.id);
  });

  it('a duplicate GSTIN is a clean 409, not a raw Prisma error', async () => {
    const existing = await makeApprovableVendor('First GSTIN Holder', 'APPROVED');
    const org = await makeOrganization('Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(app)
      .post('/api/v1/vendors')
      .set(...admin.authHeader)
      .send({
        companyName: 'Second GSTIN Holder',
        email: 'second@holder.test',
        phone: '9876500001',
        addressLine1: '5 Trade Centre',
        city: 'Ahmedabad',
        state: 'Gujarat',
        stateCode: '24',
        pincode: '380015',
        gstin: existing.gstin,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('vendor.duplicate_gstin');
    expect(JSON.stringify(res.body)).not.toContain('Invalid `prisma');
  });
});

describe('the lifecycle table', () => {
  it('a PENDING vendor cannot quote, accept or invoice', async () => {
    const { contact } = await makeApprovableVendor('Pending Supplier');
    const routes = businessRoutes();

    expect((await request(routes).post('/quotations').set(...contact.authHeader)).status).toBe(422);
    expect((await request(routes).post('/purchase-orders/accept').set(...contact.authHeader)).status).toBe(422);
    expect((await request(routes).post('/invoices').set(...contact.authHeader)).status).toBe(201);
  });

  it('an APPROVED vendor can do everything', async () => {
    const { contact } = await makeApprovableVendor('Approved Supplier', 'APPROVED');
    const routes = businessRoutes();

    expect((await request(routes).post('/quotations').set(...contact.authHeader)).status).toBe(201);
    expect((await request(routes).post('/purchase-orders/accept').set(...contact.authHeader)).status).toBe(200);
    expect((await request(routes).post('/invoices').set(...contact.authHeader)).status).toBe(201);
  });

  /**
   * The design decision worth stating out loud: suspension stops new business,
   * it does not repudiate existing obligations.
   */
  it('a SUSPENDED vendor cannot quote, but can still accept a PO and invoice', async () => {
    const { vendor, contact } = await makeApprovableVendor('Suspended Supplier', 'APPROVED');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    await request(app)
      .post(`/api/v1/platform/vendors/${vendor.id}/suspend`)
      .set(...platformAdmin.authHeader)
      .send({ reason: 'Quality review in progress' })
      .expect(200);

    const routes = businessRoutes();
    const quote = await request(routes).post('/quotations').set(...contact.authHeader);
    expect(quote.status).toBe(422);
    expect(quote.body.error.code).toBe('vendor.not_permitted');
    expect(quote.body.error.message).toMatch(/Quality review in progress/);

    expect((await request(routes).post('/purchase-orders/accept').set(...contact.authHeader)).status).toBe(200);
    expect((await request(routes).post('/invoices').set(...contact.authHeader)).status).toBe(201);
  });

  it('a BLACKLISTED vendor can still invoice for goods already delivered', async () => {
    const { vendor, contact } = await makeApprovableVendor('Blacklisted Supplier', 'APPROVED');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    await request(app)
      .post(`/api/v1/platform/vendors/${vendor.id}/blacklist`)
      .set(...platformAdmin.authHeader)
      .send({ reason: 'Repeated counterfeit supply' })
      .expect(200);

    const routes = businessRoutes();
    expect((await request(routes).post('/quotations').set(...contact.authHeader)).status).toBe(422);
    expect((await request(routes).post('/purchase-orders/accept').set(...contact.authHeader)).status).toBe(422);
    // Goods were delivered before the blacklisting; refusing the invoice would
    // be theft, not enforcement.
    expect((await request(routes).post('/invoices').set(...contact.authHeader)).status).toBe(201);
  });

  it('a REJECTED vendor is shut out entirely', async () => {
    const { vendor, contact } = await makeApprovableVendor('Rejected Supplier');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    await request(app)
      .post(`/api/v1/platform/vendors/${vendor.id}/reject`)
      .set(...platformAdmin.authHeader)
      .send({ reason: 'Documents could not be verified' })
      .expect(200);

    const routes = businessRoutes();
    expect((await request(routes).post('/quotations').set(...contact.authHeader)).status).toBe(422);
    expect((await request(routes).post('/purchase-orders/accept').set(...contact.authHeader)).status).toBe(422);
    expect((await request(routes).post('/invoices').set(...contact.authHeader)).status).toBe(422);
  });
});

describe('the state machine', () => {
  it('refuses an illegal transition', async () => {
    const { vendor } = await makeApprovableVendor('Illegal Transition Supplier');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    // Reinstating something that was never suspended.
    const res = await request(app)
      .post(`/api/v1/platform/vendors/${vendor.id}/reinstate`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('vendor.invalid_transition');
  });

  it('blacklisting is terminal', async () => {
    const { vendor } = await makeApprovableVendor('Terminal Supplier', 'APPROVED');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    await request(app)
      .post(`/api/v1/platform/vendors/${vendor.id}/blacklist`)
      .set(...platformAdmin.authHeader)
      .send({ reason: 'Fraudulent documents' })
      .expect(200);

    for (const action of ['approve', 'reinstate', 'suspend']) {
      const res = await request(app)
        .post(`/api/v1/platform/vendors/${vendor.id}/${action}`)
        .set(...platformAdmin.authHeader)
        .send({ reason: 'Changed our mind' });
      expect(res.status, action).toBe(422);
    }
  });

  it('requires a reason for the punitive transitions', async () => {
    const { vendor } = await makeApprovableVendor('Reasonless Supplier', 'APPROVED');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    for (const action of ['suspend', 'blacklist']) {
      const res = await request(app)
        .post(`/api/v1/platform/vendors/${vendor.id}/${action}`)
        .set(...platformAdmin.authHeader)
        .send({});
      expect(res.status, action).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });

  it('an org admin cannot approve or blacklist a vendor', async () => {
    const { vendor } = await makeApprovableVendor('Guarded Supplier');
    const org = await makeOrganization('Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    expect(
      (await request(app).post(`/api/v1/platform/vendors/${vendor.id}/approve`).set(...admin.authHeader)).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/v1/platform/vendors/${vendor.id}/blacklist`)
          .set(...admin.authHeader)
          .send({ reason: 'No reason' })
      ).status,
    ).toBe(403);
  });
});

describe('directory', () => {
  it('sorts no-history vendors last on -rating, not first', async () => {
    const rated = await makeApprovableVendor('Rated Supplier', 'APPROVED');
    const unrated = await makeApprovableVendor('Unrated Supplier', 'APPROVED');
    const mid = await makeApprovableVendor('Middling Supplier', 'APPROVED');

    await prisma.vendor.update({ where: { id: rated.vendor.id }, data: { rating: '4.60' } });
    await prisma.vendor.update({ where: { id: mid.vendor.id }, data: { rating: '3.10' } });

    const org = await makeOrganization('Buyer Ltd');
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });

    const res = await request(app)
      .get('/api/v1/vendors?sort=-rating')
      .set(...officer.authHeader);

    expect(res.status).toBe(200);
    const names = res.body.data.map((v: { companyName: string }) => v.companyName);
    expect(names[0]).toBe('Rated Supplier');
    expect(names[1]).toBe('Middling Supplier');
    // Postgres puts NULLs first on DESC by default — this is the bug that makes
    // a demo look broken.
    expect(names[2]).toBe('Unrated Supplier');
    expect(res.body.data[2].rating).toBeNull();
    expect(unrated.vendor.rating).toBeNull();
  });

  it('searches company name, city and GSTIN case-insensitively', async () => {
    await makeApprovableVendor('Network Systems', 'APPROVED');
    await makeApprovableVendor('Concrete Works', 'APPROVED');
    const org = await makeOrganization('Buyer Ltd');
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });

    const byName = await request(app).get('/api/v1/vendors?search=network').set(...officer.authHeader);
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].companyName).toBe('Network Systems');

    const byCity = await request(app).get('/api/v1/vendors?search=SURAT').set(...officer.authHeader);
    expect(byCity.body.meta.total).toBe(2);
  });

  it('filters by category and hides vendors that are not approved', async () => {
    const approved = await makeApprovableVendor('Visible Supplier', 'APPROVED');
    await makeApprovableVendor('Hidden Supplier');
    const org = await makeOrganization('Buyer Ltd');
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });

    const all = await request(app).get('/api/v1/vendors').set(...officer.authHeader);
    expect(all.body.data).toHaveLength(1);
    expect(all.body.data[0].companyName).toBe('Visible Supplier');

    const byCategory = await request(app)
      .get(`/api/v1/vendors?categoryId=${approved.category.id}`)
      .set(...officer.authHeader);
    expect(byCategory.body.data).toHaveLength(1);
  });
});

describe('self-service', () => {
  it('a vendor sets its own categories', async () => {
    const { contact } = await makeApprovableVendor('Category Supplier');
    const extra = await makeCategory('Electrical Works');

    const res = await request(app)
      .patch('/api/v1/vendors/me/categories')
      .set(...contact.authHeader)
      .send({ categoryIds: [extra.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.categories).toHaveLength(1);
    expect(res.body.data.categories[0].name).toBe('Electrical Works');
  });

  it('a vendor can read the category list to pick from', async () => {
    const { contact } = await makeApprovableVendor('Listing Supplier');
    await makeCategory('Civil Works');

    const res = await request(app).get('/api/v1/categories').set(...contact.authHeader);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('bank changes are audited without recording the value', async () => {
    const { contact } = await makeApprovableVendor('Banking Supplier');

    await request(app)
      .patch('/api/v1/vendors/me')
      .set(...contact.authHeader)
      .send({ bankAccountNumber: '99887766554433' })
      .expect(200);

    const audit = await prisma.activityLog.findFirst({
      where: { action: 'vendor.updated' },
      orderBy: { sequence: 'desc' },
    });

    expect(JSON.stringify(audit?.after)).toContain('[changed]');
    expect(JSON.stringify(audit?.after)).not.toContain('99887766554433');
  });

  it('one vendor cannot read another vendor through /vendors/me', async () => {
    const first = await makeApprovableVendor('First Supplier', 'APPROVED');
    const second = await makeApprovableVendor('Second Supplier', 'APPROVED');

    const res = await request(app).get('/api/v1/vendors/me').set(...first.contact.authHeader);

    expect(res.body.data.id).toBe(first.vendor.id);
    expect(res.body.data.id).not.toBe(second.vendor.id);
  });
});

describe('scorecard', () => {
  it('returns null rating and empty breakdown for a vendor with no history', async () => {
    const { vendor, contact } = await makeApprovableVendor('New Supplier', 'APPROVED');

    const res = await request(app).get('/api/v1/vendors/me/scorecard').set(...contact.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.vendorId).toBe(vendor.id);
    // Null, never 0 — plan 09 reads null as neutral, and a zero would quietly
    // blacklist every supplier who has not worked with us yet.
    expect(res.body.data.rating).toBeNull();
    expect(res.body.data.ratingBreakdown).toEqual([]);
    expect(res.body.data.orders.total).toBe(0);
    expect(res.body.data.value.awarded).toBe('0.00');
  });

  it('computes rating from delivery, quality, invoicing and participation', async () => {
    const { vendor, contact } = await makeApprovableVendor('Performing Supplier', 'APPROVED');
    const org = await makeOrganization('Buyer Ltd');
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });

    const po = await prisma.purchaseOrder.create({
      data: {
        organizationId: org.id,
        vendorId: vendor.id,
        poNumber: 'PO/SCORE/000001',
        buyerName: org.name,
        buyerAddress: '1 Ring Road',
        buyerStateCode: '24',
        vendorName: vendor.companyName,
        vendorAddress: '9 Industrial Estate',
        vendorStateCode: '24',
        placeOfSupplyStateCode: '24',
        taxRegime: 'INTRA_STATE',
        expectedDeliveryDate: new Date('2026-01-10T00:00:00Z'),
        deliveryAddress: '1 Ring Road',
        createdById: officer.user.id,
        status: 'CLOSED',
        totalAmount: '118000.00',
      },
    });

    const poItem = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        srNo: 1,
        description: 'Cable drum',
        unit: 'NOS',
        quantity: '100.000',
        unitPrice: '1000.00',
        taxableValue: '100000.00',
        taxRatePercent: '18.00',
        lineTotal: '118000.00',
      },
    });

    // One delivery on time, one late by two days.
    await prisma.delivery.create({
      data: {
        purchaseOrderId: po.id,
        vendorId: vendor.id,
        challanNumber: 'CH-1',
        dispatchedAt: new Date('2026-01-05T00:00:00Z'),
        deliveredAt: new Date('2026-01-09T00:00:00Z'),
        status: 'DELIVERED',
      },
    });
    await prisma.delivery.create({
      data: {
        purchaseOrderId: po.id,
        vendorId: vendor.id,
        challanNumber: 'CH-2',
        dispatchedAt: new Date('2026-01-08T00:00:00Z'),
        deliveredAt: new Date('2026-01-12T00:00:00Z'),
        status: 'DELIVERED',
      },
    });

    const grn = await prisma.grn.create({
      data: {
        organizationId: org.id,
        purchaseOrderId: po.id,
        grnNumber: 'GRN/SCORE/000001',
        status: 'PARTIALLY_ACCEPTED',
        receivedById: officer.user.id,
        receivedAt: new Date('2026-01-12T00:00:00Z'),
      },
    });
    await prisma.grnItem.create({
      data: {
        grnId: grn.id,
        purchaseOrderItemId: poItem.id,
        receivedQuantity: '100.000',
        acceptedQuantity: '90.000',
        rejectedQuantity: '10.000',
      },
    });

    await prisma.invoice.create({
      data: {
        organizationId: org.id,
        vendorId: vendor.id,
        purchaseOrderId: po.id,
        vendorInvoiceNumber: 'V-1',
        referenceNumber: 'INV/SCORE/000001',
        invoiceDate: new Date(),
        dueDate: new Date(),
        status: 'PAID',
        matchStatus: 'MATCHED',
        totalAmount: '118000.00',
        amountPaid: '118000.00',
      },
    });

    const res = await request(app).get('/api/v1/vendors/me/scorecard').set(...contact.authHeader);

    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.orders).toMatchObject({ total: 1, completed: 1, cancelled: 0, inProgress: 0 });
    expect(data.value.awarded).toBe('118000.00');
    expect(data.value.paid).toBe('118000.00');

    expect(data.delivery).toMatchObject({ onTime: 1, late: 1, onTimeRate: 50 });
    expect(data.delivery.avgDelayDays).toBe(2);

    expect(data.quality.totalReceived).toBe('100.000');
    expect(data.quality.accepted).toBe('90.000');
    expect(data.quality.rejectionRate).toBe(10);

    expect(data.invoicing).toMatchObject({ submitted: 1, matched: 1, exceptions: 0, exceptionRate: 0 });

    // 50 on-time (w40), 90 quality (w30), 100 invoicing (w20) -> no bidding data,
    // so the weights renormalise over the three factors that exist.
    expect(data.ratingBreakdown).toHaveLength(3);
    const expected =
      Math.round(((40 * 50 + 30 * 90 + 20 * 100) / 90 / 20) * 100) / 100;
    expect(data.rating).toBe(expected);
    expect(data.rating).toBeGreaterThan(3);
    expect(data.rating).toBeLessThanOrEqual(5);
  });

  it('a buyer can read a vendor scorecard, a vendor cannot read another vendor', async () => {
    const first = await makeApprovableVendor('Scored Supplier', 'APPROVED');
    const second = await makeApprovableVendor('Nosy Supplier', 'APPROVED');
    const org = await makeOrganization('Buyer Ltd');
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });

    expect(
      (await request(app).get(`/api/v1/vendors/${first.vendor.id}/scorecard`).set(...officer.authHeader)).status,
    ).toBe(200);

    // A vendor holds no VENDOR_VIEW permission at all.
    expect(
      (
        await request(app)
          .get(`/api/v1/vendors/${first.vendor.id}/scorecard`)
          .set(...second.contact.authHeader)
      ).status,
    ).toBe(403);
  });
});
