import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { gstinChecksum } from '@tb/shared';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { closeExpired, runDeadlineSweep } from '../src/modules/tender/deadline.service.js';
import { makeOrganization, makeUser, makeVendor, type TestActor } from './helpers/actors.js';
import { disconnect, truncateAll } from './helpers/db.js';

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let seed = 0;
const uniqueGstin = (stateCode = '24') => {
  const index = seed++;
  const base = `${stateCode}AAB${LETTERS[index % 26]}${LETTERS[(index / 26) % 26 | 0]}1234F1Z`;
  return base + gstinChecksum(base);
};

async function makeApprovedVendor(name: string, stateCode = '24') {
  const vendor = await makeVendor(name);
  await prisma.vendor.update({
    where: { id: vendor.id },
    data: { status: 'APPROVED', gstin: uniqueGstin(stateCode), stateCode },
  });
  const contact = await makeUser('VENDOR', { vendorId: vendor.id });
  return { vendor, contact };
}

interface Fixture {
  org: Awaited<ReturnType<typeof makeOrganization>>;
  officer: TestActor;
  admin: TestActor;
  vendors: Awaited<ReturnType<typeof makeApprovedVendor>>[];
}

async function fixture(vendorCount = 3): Promise<Fixture> {
  const org = await makeOrganization('Meridian Industries');
  const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });
  const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

  const vendors = [];
  for (let i = 0; i < vendorCount; i++) {
    vendors.push(await makeApprovedVendor(`Supplier ${i + 1}-${Date.now()}`));
  }
  return { org, officer, admin, vendors };
}

const tenderPayload = (overrides: Record<string, unknown> = {}) => ({
  title: 'Supply of 24-port managed switches',
  description: 'Managed L2+ switches with PoE for the Ahmedabad plant network refresh.',
  estimatedBudget: '850000.00',
  deliveryLocation: 'Plot 12, GIDC Estate, Ahmedabad',
  deliveryStateCode: '24',
  deliveryDeadline: hours(72),
  bidSubmissionDeadline: hours(24),
  evaluationMethod: 'LOWEST_PRICE',
  termsAndConditions: 'Payment 30 days from GRN.',
  items: [
    {
      srNo: 1,
      description: '24-port managed switch, L2+, PoE',
      specifications: '1U rack, 370 W PoE budget',
      hsnCode: '8517',
      unit: 'NOS',
      quantity: '12.000',
      taxRatePercent: '18.00',
      estimatedUnitPrice: '62000.00',
    },
    {
      srNo: 2,
      description: 'SFP+ 10G module',
      hsnCode: '8517',
      unit: 'NOS',
      quantity: '24.000',
      taxRatePercent: '18.00',
    },
  ],
  ...overrides,
});

async function createDraft(f: Fixture, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/tenders')
    .set(...f.officer.authHeader)
    .send(tenderPayload(overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function inviteAll(f: Fixture, tenderId: string, count = f.vendors.length) {
  const res = await request(app)
    .post(`/api/v1/tenders/${tenderId}/invitations`)
    .set(...f.officer.authHeader)
    .send({ vendorIds: f.vendors.slice(0, count).map((v) => v.vendor.id) });
  expect(res.status).toBe(201);
}

/**
 * Not `async`: callers chain `.expect(200)` on it, and an async wrapper returns
 * a Promise, which has no `.expect`. The thrown TypeError leaves the underlying
 * request un-awaited, so it lands in the *next* test — after its truncate —
 * which is how one helper produced sixteen unrelated failures.
 */
function publish(f: Fixture, tenderId: string) {
  return request(app)
    .post(`/api/v1/tenders/${tenderId}/publish`)
    .set(...f.officer.authHeader);
}

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

describe('draft lifecycle', () => {
  it('creates an itemised draft with no reference number', async () => {
    const f = await fixture();
    const tender = await createDraft(f);

    expect(tender.status).toBe('DRAFT');
    // Numbers are reserved at publish — an abandoned draft must not consume one.
    expect(tender.referenceNumber).toBeNull();
    expect(tender.items).toHaveLength(2);
    expect(tender.items[0].quantity).toBe('12.000');
    expect(tender.estimatedBudget).toBe('850000.00');
  });

  it('rejects a deadline in the past and one after delivery', async () => {
    const f = await fixture();

    const past = await request(app)
      .post('/api/v1/tenders')
      .set(...f.officer.authHeader)
      .send(tenderPayload({ bidSubmissionDeadline: hours(-1) }));
    expect(past.status).toBe(422);

    const inverted = await request(app)
      .post('/api/v1/tenders')
      .set(...f.officer.authHeader)
      .send(tenderPayload({ bidSubmissionDeadline: hours(80), deliveryDeadline: hours(72) }));
    expect(inverted.status).toBe(422);
  });

  it('rejects non-sequential item numbers and criteria that do not sum to 100', async () => {
    const f = await fixture();

    const gappy = await request(app)
      .post('/api/v1/tenders')
      .set(...f.officer.authHeader)
      .send(
        tenderPayload({
          items: [
            { srNo: 1, description: 'First item', unit: 'NOS', quantity: '1.000', taxRatePercent: '18.00' },
            { srNo: 3, description: 'Third item', unit: 'NOS', quantity: '1.000', taxRatePercent: '18.00' },
          ],
        }),
      );
    expect(gappy.status).toBe(422);
    expect(JSON.stringify(gappy.body)).toMatch(/serial numbers/i);

    const badWeights = await request(app)
      .post('/api/v1/tenders')
      .set(...f.officer.authHeader)
      .send(
        tenderPayload({
          evaluationMethod: 'WEIGHTED_SCORE',
          criteria: [
            { key: 'price', label: 'Price', weight: 60, direction: 'lower_is_better' },
            { key: 'delivery', label: 'Delivery', weight: 30, direction: 'lower_is_better' },
          ],
        }),
      );
    expect(badWeights.status).toBe(422);
    expect(JSON.stringify(badWeights.body)).toMatch(/sum to exactly 100/i);
  });

  it('replaces items wholesale on update', async () => {
    const f = await fixture();
    const tender = await createDraft(f);

    const res = await request(app)
      .patch(`/api/v1/tenders/${tender.id}`)
      .set(...f.officer.authHeader)
      .send({
        items: [
          { srNo: 1, description: 'Replacement item only', unit: 'SET', quantity: '2.000', taxRatePercent: '12.00' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].unit).toBe('SET');
    expect(await prisma.tenderItem.count({ where: { tenderId: tender.id } })).toBe(1);
  });

  it('hard-deletes a draft, and only a draft', async () => {
    const f = await fixture();
    const tender = await createDraft(f);

    await request(app)
      .delete(`/api/v1/tenders/${tender.id}`)
      .set(...f.officer.authHeader)
      .expect(204);

    expect(await prisma.tender.count({ where: { id: tender.id } })).toBe(0);
  });

  it('refuses to edit or delete a published tender', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    const edit = await request(app)
      .patch(`/api/v1/tenders/${tender.id}`)
      .set(...f.officer.authHeader)
      .send({ title: 'Trying to change the deal after bids opened' });

    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('tender.invalid_transition');

    const remove = await request(app)
      .delete(`/api/v1/tenders/${tender.id}`)
      .set(...f.officer.authHeader);
    expect(remove.status).toBe(422);
  });
});

describe('publish', () => {
  it('refuses with fewer invited vendors than the org requires', async () => {
    const f = await fixture(2);
    const tender = await createDraft(f);
    await inviteAll(f, tender.id, 2);

    const res = await publish(f, tender.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('tender.insufficient_vendors');
    expect(res.body.error.message).toMatch(/At least 3 approved vendors/);
  });

  it('honours a lowered minVendorsPerTender', async () => {
    const f = await fixture(2);
    await request(app)
      .patch('/api/v1/organizations/me/settings')
      .set(...f.admin.authHeader)
      .send({ minVendorsPerTender: 2 })
      .expect(200);

    const tender = await createDraft(f);
    await inviteAll(f, tender.id, 2);

    expect((await publish(f, tender.id)).status).toBe(200);
  });

  it('assigns gapless fiscal-year numbers at publish', async () => {
    const f = await fixture();

    const first = await createDraft(f);
    await inviteAll(f, first.id);
    const firstPublished = await publish(f, first.id).expect(200);

    const second = await createDraft(f);
    await inviteAll(f, second.id);
    const secondPublished = await publish(f, second.id).expect(200);

    expect(firstPublished.body.data.referenceNumber).toMatch(/^TND\/\d{4}-\d{2}\/000001$/);
    expect(secondPublished.body.data.referenceNumber).toMatch(/^TND\/\d{4}-\d{2}\/000002$/);
    expect(firstPublished.body.data.publishedAt).toBeTruthy();

    // A second organization starts its own run at 000001.
    const other = await fixture();
    const otherTender = await createDraft(other);
    await inviteAll(other, otherTender.id);
    const otherPublished = await publish(other, otherTender.id).expect(200);
    expect(otherPublished.body.data.referenceNumber).toMatch(/000001$/);
  });

  it('refuses to invite a vendor that is not approved', async () => {
    const f = await fixture();
    const pending = await makeVendor('Pending Supplier');
    await prisma.vendor.update({ where: { id: pending.id }, data: { status: 'PENDING_APPROVAL' } });
    const tender = await createDraft(f);

    const res = await request(app)
      .post(`/api/v1/tenders/${tender.id}/invitations`)
      .set(...f.officer.authHeader)
      .send({ vendorIds: [pending.id] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('tender.vendor_not_approved');
  });

  it('notifies every invited vendor and audits the publish', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    const notifications = await prisma.notification.findMany({ where: { type: 'TENDER_INVITED' } });
    expect(notifications).toHaveLength(3);

    const audit = await prisma.activityLog.findFirst({ where: { action: 'tender.published' } });
    expect(audit?.severity).toBe('NOTABLE');
    expect(audit?.actorEmail).toBe(f.officer.user.email);
  });

  it('is blocked for a pending organization', async () => {
    const f = await fixture();
    await prisma.organization.update({
      where: { id: f.org.id },
      data: { status: 'PENDING_APPROVAL' },
    });
    clearOrgCache();

    const res = await request(app)
      .post('/api/v1/tenders')
      .set(...f.officer.authHeader)
      .send(tenderPayload());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('organization.not_active');
  });
});

describe('deadline handling', () => {
  /** Closing has to work on a deadline that has already passed, so the fixture
   *  is published first and then back-dated straight in the database. */
  async function publishThenExpire(f: Fixture) {
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);
    await prisma.tender.update({
      where: { id: tender.id },
      data: { bidSubmissionDeadline: new Date(Date.now() - 60_000) },
    });
    return tender;
  }

  it('closes on read, without waiting for the cron', async () => {
    const f = await fixture();
    const tender = await publishThenExpire(f);

    // Two submitted bids so the tender does not auto-cancel.
    for (const { vendor } of f.vendors.slice(0, 2)) {
      await prisma.quotation.create({
        data: {
          tenderId: tender.id,
          vendorId: vendor.id,
          referenceNumber: `QTN-${vendor.id.slice(0, 8)}`,
          status: 'SUBMITTED',
          submittedAt: new Date(),
        },
      });
    }

    const list = await request(app).get('/api/v1/tenders').set(...f.officer.authHeader);

    expect(list.status).toBe(200);
    const row = list.body.data.find((t: { id: string }) => t.id === tender.id);
    expect(row.status).toBe('BIDDING_CLOSED');
    // bidOpenedAt is what unseals the bids in plan 08.
    expect(row.bidOpenedAt).toBeTruthy();
    expect(row.closedAt).toBeTruthy();
  });

  it('auto-cancels a tender that attracted no bids', async () => {
    const f = await fixture();
    const tender = await publishThenExpire(f);

    await closeExpired(f.org.id);

    const closed = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(closed.status).toBe('CANCELLED');
    expect(closed.cancellationReason).toBe('no_bids_received');

    const notice = await prisma.notification.findFirst({ where: { type: 'TENDER_CANCELLED' } });
    expect(notice?.userId).toBeTruthy();
  });

  it('marks unsubmitted drafts as withdrawn, and does not count them as bids', async () => {
    const f = await fixture();
    const tender = await publishThenExpire(f);

    await prisma.quotation.create({
      data: {
        tenderId: tender.id,
        vendorId: f.vendors[0]!.vendor.id,
        referenceNumber: 'QTN-DRAFT',
        status: 'DRAFT',
      },
    });

    await closeExpired(f.org.id);

    const quotation = await prisma.quotation.findFirstOrThrow({ where: { tenderId: tender.id } });
    expect(quotation.status).toBe('WITHDRAWN');
    expect(quotation.withdrawalReason).toMatch(/Not submitted/);

    // A draft is not a bid, so the tender still cancels for want of bids.
    const closed = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(closed.status).toBe('CANCELLED');
  });

  it('the cron sweep closes what nobody looked at', async () => {
    const f = await fixture();
    const tender = await publishThenExpire(f);
    await prisma.quotation.create({
      data: {
        tenderId: tender.id,
        vendorId: f.vendors[0]!.vendor.id,
        referenceNumber: 'QTN-SWEEP',
        status: 'SUBMITTED',
        submittedAt: new Date(),
      },
    });

    const result = await runDeadlineSweep();

    expect(result.closed).toBeGreaterThanOrEqual(1);
    const closed = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(closed.status).toBe('BIDDING_CLOSED');
  });

  it('nudges invited vendors who have not bid, once each', async () => {
    const f = await fixture();
    const tender = await createDraft(f, { bidSubmissionDeadline: hours(12), deliveryDeadline: hours(72) });
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    await runDeadlineSweep();
    await runDeadlineSweep();

    const nudges = await prisma.notification.findMany({ where: { type: 'TENDER_CLOSING_SOON' } });
    expect(nudges).toHaveLength(3);
  });

  it('manual early close works before the deadline', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);
    await prisma.quotation.create({
      data: {
        tenderId: tender.id,
        vendorId: f.vendors[0]!.vendor.id,
        referenceNumber: 'QTN-EARLY',
        status: 'SUBMITTED',
        submittedAt: new Date(),
      },
    });

    const res = await request(app)
      .post(`/api/v1/tenders/${tender.id}/close-bidding`)
      .set(...f.officer.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('BIDDING_CLOSED');
    expect(res.body.data.bidOpenedAt).toBeTruthy();
  });
});

describe('the vendor view', () => {
  it('never contains the budget or the buyer unit prices', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    const res = await request(app)
      .get(`/api/v1/vendor/tenders/${tender.id}`)
      .set(...f.vendors[0]!.contact.authHeader);

    expect(res.status).toBe(200);

    const json = JSON.stringify(res.body);
    expect(json).not.toContain('estimatedBudget');
    expect(json).not.toContain('850000.00');
    expect(json).not.toContain('estimatedUnitPrice');
    expect(json).not.toContain('62000.00');

    // ...while everything a bidder legitimately needs is present.
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items[0].quantity).toBe('12.000');
    expect(res.body.data.buyerOrganization.name).toBe('Meridian Industries');
  });

  it('the list is equally clean', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    const res = await request(app)
      .get('/api/v1/vendor/tenders')
      .set(...f.vendors[0]!.contact.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('850000.00');
  });

  it('marks the invitation viewed on first read', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    await request(app)
      .get(`/api/v1/vendor/tenders/${tender.id}`)
      .set(...f.vendors[0]!.contact.authHeader)
      .expect(200);

    const invitation = await prisma.tenderInvitation.findFirstOrThrow({
      where: { tenderId: tender.id, vendorId: f.vendors[0]!.vendor.id },
    });
    expect(invitation.viewedAt).toBeTruthy();

    const summary = await request(app)
      .get(`/api/v1/tenders/${tender.id}/bid-summary`)
      .set(...f.officer.authHeader);
    expect(summary.body.data).toMatchObject({ invited: 3, viewed: 1, submitted: 0 });
    // Counts only — no amounts anywhere.
    expect(Object.keys(summary.body.data)).not.toContain('total');
  });

  it('a vendor who was not invited gets 404, not 403', async () => {
    const f = await fixture();
    const outsider = await makeApprovedVendor('Uninvited Supplier');
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    const res = await request(app)
      .get(`/api/v1/vendor/tenders/${tender.id}`)
      .set(...outsider.contact.authHeader);

    expect(res.status).toBe(404);
  });

  it('a vendor can decline with a reason, and the officer is told', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    const res = await request(app)
      .post(`/api/v1/vendor/tenders/${tender.id}/decline`)
      .set(...f.vendors[0]!.contact.authHeader)
      .send({ reason: 'Capacity fully booked this quarter' });

    expect(res.status).toBe(200);

    const invitation = await prisma.tenderInvitation.findFirstOrThrow({
      where: { tenderId: tender.id, vendorId: f.vendors[0]!.vendor.id },
    });
    expect(invitation.declinedReason).toMatch(/Capacity/);
    expect(invitation.respondedAt).toBeTruthy();

    const summary = await request(app)
      .get(`/api/v1/tenders/${tender.id}/bid-summary`)
      .set(...f.officer.authHeader);
    expect(summary.body.data.declined).toBe(1);
  });

  it('a suspended vendor cannot decline — that is new business', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    await prisma.vendor.update({
      where: { id: f.vendors[0]!.vendor.id },
      data: { status: 'SUSPENDED', statusReason: 'Under review' },
    });
    clearVendorCache();

    const res = await request(app)
      .post(`/api/v1/vendor/tenders/${tender.id}/decline`)
      .set(...f.vendors[0]!.contact.authHeader)
      .send({ reason: 'No longer interested' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('vendor.not_permitted');
  });
});

describe('suggested vendors', () => {
  it('explains every row and never returns an empty reason list', async () => {
    const f = await fixture(0);
    const category = await prisma.category.create({
      data: { name: 'Networking', slug: `networking-${Date.now()}` },
    });

    const local = await makeApprovedVendor('Local Networking Supplier', '24');
    await prisma.vendor.update({
      where: { id: local.vendor.id },
      data: { rating: '4.20', onTimeDeliveryRate: '92.00', categories: { connect: { id: category.id } } },
    });
    const distant = await makeApprovedVendor('Distant Supplier', '27');

    const tender = await createDraft(f, { categoryId: category.id });

    const res = await request(app)
      .get(`/api/v1/tenders/${tender.id}/suggested-vendors`)
      .set(...f.officer.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);

    for (const row of res.body.data) {
      expect(row.reasons.length).toBeGreaterThan(0);
    }

    const top = res.body.data[0];
    expect(top.vendorId).toBe(local.vendor.id);
    expect(top.reasons).toContain('Matches category: Networking');
    expect(top.reasons.some((r: string) => r.includes('intra-state'))).toBe(true);
    expect(top.reasons.some((r: string) => r.includes('On-time delivery 92%'))).toBe(true);

    // A new vendor is flagged, scored neutrally, and still explained — scoring
    // newcomers zero would freeze them out permanently.
    const newcomer = res.body.data.find((r: { vendorId: string }) => r.vendorId === distant.vendor.id);
    expect(newcomer.isNew).toBe(true);
    expect(newcomer.rating).toBeNull();
    expect(newcomer.reasons).toContain('New vendor — no performance history yet');
    expect(newcomer.score).toBeGreaterThan(0);
  });

  it('omits vendors already invited', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);

    const res = await request(app)
      .get(`/api/v1/tenders/${tender.id}/suggested-vendors`)
      .set(...f.officer.authHeader);

    expect(res.body.data).toEqual([]);
  });
});

describe('scoping and state', () => {
  it('another organization cannot see or touch the tender', async () => {
    const f = await fixture();
    const other = await fixture();
    const tender = await createDraft(f);

    expect(
      (await request(app).get(`/api/v1/tenders/${tender.id}`).set(...other.officer.authHeader)).status,
    ).toBe(404);

    const list = await request(app).get('/api/v1/tenders').set(...other.officer.authHeader);
    expect(list.body.data.map((t: { id: string }) => t.id)).not.toContain(tender.id);
  });

  it('an officer cannot cancel — that is an admin act', async () => {
    const f = await fixture();
    const tender = await createDraft(f);
    await inviteAll(f, tender.id);
    await publish(f, tender.id).expect(200);

    const officerAttempt = await request(app)
      .post(`/api/v1/tenders/${tender.id}/cancel`)
      .set(...f.officer.authHeader)
      .send({ reason: 'Requirement withdrawn by the plant' });
    expect(officerAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .post(`/api/v1/tenders/${tender.id}/cancel`)
      .set(...f.admin.authHeader)
      .send({ reason: 'Requirement withdrawn by the plant' });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.data.status).toBe('CANCELLED');
    expect(adminAttempt.body.data.cancellationReason).toMatch(/Requirement withdrawn/);
  });

  it('refuses an illegal transition', async () => {
    const f = await fixture();
    const tender = await createDraft(f);

    // close-bidding on a DRAFT: there is nothing to close.
    const res = await request(app)
      .post(`/api/v1/tenders/${tender.id}/close-bidding`)
      .set(...f.officer.authHeader);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('tender.invalid_transition');
  });

  it('cancelling a cancelled tender is refused by the state machine', async () => {
    const f = await fixture();
    const tender = await createDraft(f);

    await request(app)
      .post(`/api/v1/tenders/${tender.id}/cancel`)
      .set(...f.admin.authHeader)
      .send({ reason: 'Duplicate requirement raised in error' })
      .expect(200);

    const again = await request(app)
      .post(`/api/v1/tenders/${tender.id}/cancel`)
      .set(...f.admin.authHeader)
      .send({ reason: 'Cancelling again' });

    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('tender.invalid_transition');
  });
});
