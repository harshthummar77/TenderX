import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { makeOrganization, makeUser, makeVendor, type TestActor } from './helpers/actors.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * The heaviest suite in the project, and it needs more than the global 30s.
 *
 * One test here is a whole tender lifecycle: seed an org with three vendors,
 * draft, invite, publish, then open/price/submit a bid per vendor, then close
 * bidding and read it back. That is thirty-odd round trips to the Neon test
 * branch, and a revision test does the bid twice. They pass in ~25s run alone
 * and tip over 30s when the rest of the suite is competing for the same
 * compute — a timeout there says nothing about the code.
 */
vi.setConfig({ testTimeout: 90_000 });

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Company names carry no digits on purpose: the notification test asserts that
 * no long run of digits reaches an officer before the deadline, and a name like
 * "Supplier 1-1758031234567" would pass that check for the wrong reason.
 */
const VENDOR_NAMES = ['Acme Networks', 'Northwind Systems', 'Orion Traders', 'Vega Electricals'];

async function makeBidder(name: string) {
  const vendor = await makeVendor(name);
  const contact = await makeUser('VENDOR', { vendorId: vendor.id });
  return { vendor, contact };
}

interface Fixture {
  org: Awaited<ReturnType<typeof makeOrganization>>;
  officer: TestActor;
  admin: TestActor;
  vendors: Awaited<ReturnType<typeof makeBidder>>[];
}

async function fixture(vendorCount = 3): Promise<Fixture> {
  const org = await makeOrganization('Meridian Industries');
  const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });
  const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

  const vendors = [];
  for (let i = 0; i < vendorCount; i++) {
    vendors.push(await makeBidder(VENDOR_NAMES[i] ?? `Supplier ${VENDOR_NAMES.length + i}`));
  }
  return { org, officer, admin, vendors };
}

const tenderPayload = () => ({
  title: 'Supply of 24-port managed switches',
  description: 'Managed L2+ switches with PoE for the Ahmedabad plant network refresh.',
  estimatedBudget: '850000.00',
  deliveryLocation: 'Plot 12, GIDC Estate, Ahmedabad',
  deliveryStateCode: '24',
  deliveryDeadline: hours(72),
  bidSubmissionDeadline: hours(24),
  evaluationMethod: 'LOWEST_PRICE',
  items: [
    {
      srNo: 1,
      description: '24-port managed switch, L2+, PoE',
      unit: 'NOS',
      quantity: '12.000',
      taxRatePercent: '18.00',
      estimatedUnitPrice: '62000.00',
    },
    {
      srNo: 2,
      description: 'SFP+ 10G module',
      unit: 'NOS',
      quantity: '24.000',
      taxRatePercent: '18.00',
    },
  ],
});

/** A published tender with every fixture vendor invited. */
async function publishedTender(f: Fixture) {
  const draft = await request(app)
    .post('/api/v1/tenders')
    .set(...f.officer.authHeader)
    .send(tenderPayload());
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);

  await request(app)
    .post(`/api/v1/tenders/${draft.body.data.id}/invitations`)
    .set(...f.officer.authHeader)
    .send({ vendorIds: f.vendors.map((v) => v.vendor.id) })
    .expect(201);

  const published = await request(app)
    .post(`/api/v1/tenders/${draft.body.data.id}/publish`)
    .set(...f.officer.authHeader);
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  return published.body.data;
}

const openDraft = async (f: Fixture, tenderId: string, vendorIndex: number) => {
  const res = await request(app)
    .post(`/api/v1/vendor/tenders/${tenderId}/quotation`)
    .set(...f.vendors[vendorIndex]!.contact.authHeader);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};

const priceDraft = (
  f: Fixture,
  vendorIndex: number,
  draft: { id: string; items: { tenderItemId: string; quantity: string }[] },
  prices: string[],
  extra: Record<string, unknown> = {},
) =>
  request(app)
    .patch(`/api/v1/vendor/quotations/${draft.id}`)
    .set(...f.vendors[vendorIndex]!.contact.authHeader)
    .send({
      deliveryDays: 21,
      validityDays: 45,
      paymentTerms: '30 days from invoice',
      items: draft.items.map((item, index) => ({
        tenderItemId: item.tenderItemId,
        quantity: item.quantity,
        unitPrice: prices[index]!,
      })),
      ...extra,
    });

const submitBid = (f: Fixture, vendorIndex: number, quotationId: string) =>
  request(app)
    .post(`/api/v1/vendor/quotations/${quotationId}/submit`)
    .set(...f.vendors[vendorIndex]!.contact.authHeader);

/** Open, price and submit one bid, end to end through the API. */
async function placeBid(f: Fixture, tenderId: string, vendorIndex: number, prices: string[]) {
  const draft = await openDraft(f, tenderId, vendorIndex);
  const priced = await priceDraft(f, vendorIndex, draft, prices);
  expect(priced.status, JSON.stringify(priced.body)).toBe(200);

  const submitted = await submitBid(f, vendorIndex, draft.id);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return submitted.body.data;
}

/**
 * The §1 fixture: a still-open tender with `count` sealed bids on it. At least
 * three vendors are always invited — `minVendorsPerTender` defaults to 3, and a
 * single-source tender is refused at publish (07 §4).
 */
async function seedTenderWithBids(count = 3) {
  const f = await fixture(Math.max(3, count));
  const tender = await publishedTender(f);

  const quotations = [];
  for (let i = 0; i < count; i++) {
    quotations.push(await placeBid(f, tender.id, i, [`${58500 + i * 1000}.00`, `${8200 + i * 100}.00`]));
  }
  return { f, tender, quotations };
}

/** Open the bids the way the officer does: close bidding early. */
const closeBidding = (f: Fixture, tenderId: string) =>
  request(app)
    .post(`/api/v1/tenders/${tenderId}/close-bidding`)
    .set(...f.officer.authHeader);

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */

describe('draft lifecycle', () => {
  it('seeds a draft with one unpriced line per tender line', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);

    const draft = await openDraft(f, tender.id, 0);

    expect(draft.status).toBe('DRAFT');
    expect(draft.referenceNumber).toBeNull();
    expect(draft.items).toHaveLength(2);
    expect(draft.items[0].quantity).toBe('12.000');
    expect(draft.items[0].unitPrice).toBe('0.00');
    expect(draft.grandTotal).toBe('0.00');
  });

  it('is idempotent — pressing "Bid now" twice does not fork the bid', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);

    const first = await openDraft(f, tender.id, 0);
    const second = await openDraft(f, tender.id, 0);

    expect(second.id).toBe(first.id);
    expect(await prisma.quotation.count({ where: { tenderId: tender.id } })).toBe(1);
  });

  it('refuses a vendor who was not invited', async () => {
    const f = await fixture();
    const outsider = await makeBidder('Uninvited Supplies');
    const tender = await publishedTender(f);

    const res = await request(app)
      .post(`/api/v1/vendor/tenders/${tender.id}/quotation`)
      .set(...outsider.contact.authHeader);

    expect(res.status).toBe(404);
  });

  /** Plan 08 §10 — the arithmetic verified by hand once. */
  it('recomputes every figure from the line inputs', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);

    const res = await priceDraft(f, 0, draft, ['58500.00', '8200.00'], {
      freightAmount: '4500.00',
      items: draft.items.map((item: { tenderItemId: string; quantity: string }, index: number) => ({
        tenderItemId: item.tenderItemId,
        quantity: item.quantity,
        unitPrice: index === 0 ? '58500.00' : '8200.00',
        discountPercent: index === 0 ? '2.00' : '0.00',
      })),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.items[0].taxableValue).toBe('687960.00');
    expect(res.body.data.items[0].taxAmount).toBe('123832.80');
    expect(res.body.data.items[0].lineTotal).toBe('811792.80');
    expect(res.body.data.subtotal).toBe('898800.00');
    expect(res.body.data.taxableAmount).toBe('884760.00');
    expect(res.body.data.grandTotal).toBe('1048516.80'); // 884760 + 159256.80 + 4500
  });

  it('ignores a forged grand total in the body', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);

    const res = await priceDraft(f, 0, draft, ['1000.00', '500.00'], {
      subtotal: '1.00',
      taxAmount: '0.00',
      grandTotal: '1.00',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.grandTotal).toBe('28320.00'); // (12000 + 12000) × 1.18

    const stored = await prisma.quotation.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stored.grandTotal.toFixed(2)).toBe('28320.00');
  });

  it('refuses a short quantity — partial bids are out of scope', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);

    const res = await request(app)
      .patch(`/api/v1/vendor/quotations/${draft.id}`)
      .set(...f.vendors[0]!.contact.authHeader)
      .send({
        items: [{ tenderItemId: draft.items[0].tenderItemId, quantity: '6.000', unitPrice: '100.00' }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quotation.quantity_mismatch');
  });

  it('refuses a line that belongs to another tender', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const other = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);
    const otherItems = await prisma.tenderItem.findMany({ where: { tenderId: other.id } });

    const res = await request(app)
      .patch(`/api/v1/vendor/quotations/${draft.id}`)
      .set(...f.vendors[0]!.contact.authHeader)
      .send({
        items: [{ tenderItemId: otherItems[0]!.id, quantity: '12.000', unitPrice: '100.00' }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quotation.unknown_item');
  });

  it("a vendor cannot read another vendor's quotation", async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);

    const res = await request(app)
      .get(`/api/v1/vendor/quotations/${draft.id}`)
      .set(...f.vendors[1]!.contact.authHeader);

    expect(res.status).toBe(404);
  });
});

describe('submission guards', () => {
  it('numbers, seals and timestamps a valid submission', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const bid = await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    expect(bid.status).toBe('SUBMITTED');
    expect(bid.referenceNumber).toMatch(/^QTN\/\d{4}-\d{2}\/\d{6}$/);
    expect(bid.submittedAt).toBeTruthy();
    expect(bid.sealHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bid.isLatest).toBe(true);
    expect(bid.revisionNumber).toBe(1);
  });

  it('refuses a draft with an unpriced line', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);

    const res = await submitBid(f, 0, draft.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quotation.invalid_price');
  });

  it('refuses a draft that is missing a tender line', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);

    await request(app)
      .patch(`/api/v1/vendor/quotations/${draft.id}`)
      .set(...f.vendors[0]!.contact.authHeader)
      .send({
        items: [{ tenderItemId: draft.items[0].tenderItemId, quantity: '12.000', unitPrice: '100.00' }],
      })
      .expect(200);

    const res = await submitBid(f, 0, draft.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quotation.incomplete_items');
  });

  /**
   * The deadline is compared against `now()` in Postgres, so a client whose
   * clock disagrees changes nothing. The tender is left PUBLISHED on purpose —
   * this is guard 4 firing, not the status guard.
   */
  it('refuses a submission after the deadline, whatever the client believes', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);
    await priceDraft(f, 0, draft, ['58500.00', '8200.00']).expect(200);

    await prisma.tender.update({
      where: { id: tender.id },
      data: { bidSubmissionDeadline: new Date(Date.now() - 60_000) },
    });

    const res = await submitBid(f, 0, draft.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quotation.deadline_passed');
  });

  it('refuses a vendor whose approval was pulled after the invitation', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);
    await priceDraft(f, 0, draft, ['58500.00', '8200.00']).expect(200);

    await prisma.vendor.update({
      where: { id: f.vendors[0]!.vendor.id },
      data: { status: 'SUSPENDED', statusReason: 'Under review' },
    });
    clearVendorCache();

    const res = await submitBid(f, 0, draft.id);

    // The route gate fires first; either way the bid does not land.
    expect(res.status).toBe(422);
    expect(['vendor.not_permitted', 'quotation.vendor_not_approved']).toContain(res.body.error.code);
    expect(await prisma.quotation.count({ where: { id: draft.id, status: 'SUBMITTED' } })).toBe(0);
  });

  it('refuses a submission once the tender is no longer published', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);
    await priceDraft(f, 0, draft, ['58500.00', '8200.00']).expect(200);

    await prisma.tender.update({ where: { id: tender.id }, data: { status: 'CANCELLED' } });

    const res = await submitBid(f, 0, draft.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quotation.tender_not_open');
  });

  /**
   * Two rapid submits are the *same row*, so the partial unique index cannot
   * separate them — the `FOR UPDATE` row lock in the submit transaction does.
   */
  it('turns a double-click into one bid and one 422', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);
    await priceDraft(f, 0, draft, ['58500.00', '8200.00']).expect(200);

    const [first, second] = await Promise.all([
      submitBid(f, 0, draft.id),
      submitBid(f, 0, draft.id),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 422]);

    const loser = first.status === 422 ? first : second;
    expect(loser.body.error.code).toBe('quotation.already_submitted');

    expect(
      await prisma.quotation.count({ where: { tenderId: tender.id, status: 'SUBMITTED' } }),
    ).toBe(1);
  });

  it('refuses to reopen a draft once a bid is live', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    const res = await request(app)
      .post(`/api/v1/vendor/tenders/${tender.id}/quotation`)
      .set(...f.vendors[0]!.contact.authHeader);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quotation.already_submitted');
  });
});

/* -------------------------------------------------------------------------- */
/* The seal (08 §1)                                                           */
/* -------------------------------------------------------------------------- */

describe('sealing', () => {
  /**
   * **The test this module exists for.** Adding a buyer endpoint later means
   * adding its URL to this list. That is deliberate friction.
   */
  it('no buyer endpoint leaks a bid amount before the deadline', async () => {
    const { f, tender, quotations } = await seedTenderWithBids(3);
    const amounts = quotations.flatMap((q) => [q.grandTotal, q.subtotal, q.taxableAmount]);

    for (const url of [
      `/api/v1/tenders/${tender.id}`,
      `/api/v1/tenders/${tender.id}/quotations`,
      `/api/v1/tenders/${tender.id}/bid-summary`,
      `/api/v1/tenders/${tender.id}/comparison`, // plan 09; a 404 must stay a 404
      ...quotations.map((q) => `/api/v1/quotations/${q.id}`),
    ]) {
      const res = await request(app)
        .get(url)
        .set(...f.officer.authHeader);
      const body = JSON.stringify(res.body);

      for (const amount of amounts) {
        expect(body, `${url} leaked ${amount}`).not.toContain(amount);
      }
      expect(body, `${url} leaked the grandTotal key`).not.toContain('grandTotal');
      expect(body).not.toContain('unitPrice');
      expect(body).not.toContain('priceScore');
    }
  });

  it('shows the officer who bid and when, with a seal hash instead of a price', async () => {
    const { f, tender, quotations } = await seedTenderWithBids(2);

    const res = await request(app)
      .get(`/api/v1/tenders/${tender.id}/quotations`)
      .set(...f.officer.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].sealed).toBe(true);
    expect(res.body.data[0].vendor.companyName).toBeTruthy();
    expect(res.body.data[0].submittedAt).toBeTruthy();
    expect(res.body.data[0].itemCount).toBe(2);
    expect(res.body.data[0].sealHash).toBe(quotations[0]!.sealHash);
  });

  it('a vendor always sees their own amounts — the seal is the buyer-side rule', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const bid = await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    const res = await request(app)
      .get(`/api/v1/vendor/quotations/${bid.id}`)
      .set(...f.vendors[0]!.contact.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.grandTotal).toBe(bid.grandTotal);
    expect(res.body.data.items[0].unitPrice).toBe('58500.00');
  });

  it('returns every amount the moment bidding closes', async () => {
    const { f, tender, quotations } = await seedTenderWithBids(3);

    await closeBidding(f, tender.id).expect(200);

    const list = await request(app)
      .get(`/api/v1/tenders/${tender.id}/quotations`)
      .set(...f.officer.authHeader);

    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data[0].sealed).toBe(false);
    expect(list.body.data.map((q: { grandTotal: string }) => q.grandTotal)).toEqual(
      expect.arrayContaining(quotations.map((q) => q.grandTotal)),
    );

    const detail = await request(app)
      .get(`/api/v1/quotations/${quotations[0]!.id}`)
      .set(...f.officer.authHeader);

    expect(detail.body.data.sealed).toBe(false);
    expect(detail.body.data.grandTotal).toBe(quotations[0]!.grandTotal);
    expect(detail.body.data.items).toHaveLength(2);
  });

  it('keeps a bid out of reach of another organization', async () => {
    const { tender, quotations } = await seedTenderWithBids(1);
    const rivalOrg = await makeOrganization('Rival Industries');
    const rivalOfficer = await makeUser('ORG_OFFICER', { organizationId: rivalOrg.id });

    await request(app)
      .get(`/api/v1/tenders/${tender.id}/quotations`)
      .set(...rivalOfficer.authHeader)
      .expect(404);

    await request(app)
      .get(`/api/v1/quotations/${quotations[0]!.id}`)
      .set(...rivalOfficer.authHeader)
      .expect(404);
  });
});

describe('bid summary', () => {
  it('counts without revealing, and counts a draft as a draft', async () => {
    const f = await fixture(3);
    const tender = await publishedTender(f);

    await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);
    await openDraft(f, tender.id, 1); // started, never submitted
    await request(app)
      .post(`/api/v1/vendor/tenders/${tender.id}/decline`)
      .set(...f.vendors[2]!.contact.authHeader)
      .send({ reason: 'Capacity fully booked this quarter' })
      .expect(200);

    const res = await request(app)
      .get(`/api/v1/tenders/${tender.id}/bid-summary`)
      .set(...f.officer.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ invited: 3, declined: 1, drafts: 1, submitted: 1, sealed: true });
    expect(res.body.data.secondsRemaining).toBeGreaterThan(0);
    expect(res.body.data.submissions).toHaveLength(1);
    expect(res.body.data.submissions[0].vendorName).toBe('Acme Networks');
    expect(res.body.data.submissions[0].sealHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(res.body.data)).not.toContain('grandTotal');
  });
});

describe('seal verification', () => {
  it('confirms an untouched bid and catches an edited one', async () => {
    const { f, tender, quotations } = await seedTenderWithBids(1);
    const bid = quotations[0]!;

    // Sealed: there is nothing to verify yet, and re-running it after an edit is
    // exactly the attack this guards against.
    const early = await request(app)
      .post(`/api/v1/quotations/${bid.id}/verify-seal`)
      .set(...f.officer.authHeader);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('quotation.still_sealed');

    await closeBidding(f, tender.id).expect(200);

    const valid = await request(app)
      .post(`/api/v1/quotations/${bid.id}/verify-seal`)
      .set(...f.officer.authHeader);
    expect(valid.status).toBe(200);
    expect(valid.body.data.valid).toBe(true);
    expect(valid.body.data.sealHash).toBe(bid.sealHash);

    // The Studio edit from the acceptance list, performed in code.
    const item = await prisma.quotationItem.findFirstOrThrow({ where: { quotationId: bid.id } });
    await prisma.quotationItem.update({
      where: { id: item.id },
      data: { unitPrice: item.unitPrice.minus(1) },
    });

    const tampered = await request(app)
      .post(`/api/v1/quotations/${bid.id}/verify-seal`)
      .set(...f.officer.authHeader);
    expect(tampered.status).toBe(200);
    expect(tampered.body.data.valid).toBe(false);
    expect(tampered.body.data.computedHash).not.toBe(bid.sealHash);
  });
});

/* -------------------------------------------------------------------------- */
/* Revisions and withdrawal                                                   */
/* -------------------------------------------------------------------------- */

describe('revisions', () => {
  it('forks a new draft and leaves exactly one row latest', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const original = await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    const res = await request(app)
      .post(`/api/v1/vendor/quotations/${original.id}/revise`)
      .set(...f.vendors[0]!.contact.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.revisionNumber).toBe(2);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.revisionOfId).toBe(original.id);
    expect(res.body.data.sealHash).toBeNull();
    expect(res.body.data.submittedAt).toBeNull();
    expect(res.body.data.items).toHaveLength(2);

    // The original survives intact — that is the whole point of a revision.
    const kept = await prisma.quotation.findUniqueOrThrow({ where: { id: original.id } });
    expect(kept.status).toBe('SUBMITTED');
    expect(kept.isLatest).toBe(false);
    expect(kept.sealHash).toBe(original.sealHash);

    const latest = await prisma.quotation.count({
      where: { tenderId: tender.id, vendorId: f.vendors[0]!.vendor.id, isLatest: true },
    });
    expect(latest).toBe(1);
  });

  it('re-prices and re-submits, and the buyer still sees one bid', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const original = await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    const revision = await request(app)
      .post(`/api/v1/vendor/quotations/${original.id}/revise`)
      .set(...f.vendors[0]!.contact.authHeader);
    expect(revision.status).toBe(201);

    await priceDraft(f, 0, revision.body.data, ['57000.00', '8000.00']).expect(200);
    const resubmitted = await submitBid(f, 0, revision.body.data.id);
    expect(resubmitted.status, JSON.stringify(resubmitted.body)).toBe(200);
    expect(resubmitted.body.data.grandTotal).not.toBe(original.grandTotal);

    await closeBidding(f, tender.id).expect(200);

    const list = await request(app)
      .get(`/api/v1/tenders/${tender.id}/quotations`)
      .set(...f.officer.authHeader);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].grandTotal).toBe(resubmitted.body.data.grandTotal);
  });

  it('refuses to revise a draft', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const draft = await openDraft(f, tender.id, 0);

    const res = await request(app)
      .post(`/api/v1/vendor/quotations/${draft.id}/revise`)
      .set(...f.vendors[0]!.contact.authHeader);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quotation.invalid_transition');
  });
});

describe('withdrawal', () => {
  it('withdraws a live bid with a reason and tells the officer', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const bid = await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    const res = await request(app)
      .post(`/api/v1/vendor/quotations/${bid.id}/withdraw`)
      .set(...f.vendors[0]!.contact.authHeader)
      .send({ reason: 'Component lead times have doubled since we priced this' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('WITHDRAWN');
    expect(res.body.data.withdrawnAt).toBeTruthy();
    expect(res.body.data.withdrawalReason).toMatch(/lead times/);

    const notified = await prisma.notification.count({
      where: { userId: f.officer.user.id, type: 'QUOTATION_WITHDRAWN' },
    });
    expect(notified).toBe(1);

    // A withdrawn bid is not a submission.
    const summary = await request(app)
      .get(`/api/v1/tenders/${tender.id}/bid-summary`)
      .set(...f.officer.authHeader);
    expect(summary.body.data.submitted).toBe(0);
  });

  it('demands a reason worth reading', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const bid = await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    const res = await request(app)
      .post(`/api/v1/vendor/quotations/${bid.id}/withdraw`)
      .set(...f.vendors[0]!.contact.authHeader)
      .send({ reason: 'nope' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  /** After the deadline a bid is binding — that is what a sealed tender means. */
  it('refuses to withdraw once the deadline has passed', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const bid = await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    await prisma.tender.update({
      where: { id: tender.id },
      data: { bidSubmissionDeadline: new Date(Date.now() - 60_000) },
    });

    const res = await request(app)
      .post(`/api/v1/vendor/quotations/${bid.id}/withdraw`)
      .set(...f.vendors[0]!.contact.authHeader)
      .send({ reason: 'We would rather not honour this one' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quotation.deadline_passed');
  });
});

/* -------------------------------------------------------------------------- */

describe('notifications', () => {
  /**
   * An email that says "Acme bid ₹6,89,000" defeats the entire seal. The check
   * is structural rather than exact: no run of four or more digits reaches the
   * officer, so no amount, reference number or timestamp can hide in the body.
   */
  it('tells the officer a bid arrived without telling them how much', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const bid = await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { userId: f.officer.user.id, type: 'QUOTATION_RECEIVED' },
    });

    expect(notification.body).toContain('Acme Networks');
    expect(notification.body).not.toContain(bid.grandTotal);
    expect(notification.body).not.toContain(bid.subtotal);
    expect(notification.body).not.toMatch(/\d{4,}/);
    expect(notification.title).not.toMatch(/\d{4,}/);
  });

  it('writes an audit row that carries the seal, not the amount', async () => {
    const f = await fixture();
    const tender = await publishedTender(f);
    const bid = await placeBid(f, tender.id, 0, ['58500.00', '8200.00']);

    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'quotation.submitted', entityId: bid.id },
    });

    // `sequence` is a BigInt, which JSON.stringify refuses — stringify the parts
    // that could actually carry an amount.
    const written = JSON.stringify([entry.summary, entry.before, entry.after]);
    expect(JSON.stringify(entry.after)).toContain(bid.sealHash);
    expect(written).not.toContain(bid.grandTotal);
    expect(written).not.toContain(bid.subtotal);
  });
});
