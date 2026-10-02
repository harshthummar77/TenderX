import request from 'supertest';
import { expect } from 'vitest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { makeOrganization, makeUser, makeVendor, type TestActor } from './actors.js';

/**
 * A tender with real bids on it, built through the API rather than seeded.
 *
 * Plans 09 onwards all start from "bids are open and comparable", and getting
 * there is a dozen HTTP calls. Doing it through the API keeps the fixture
 * honest: every guard in plans 07 and 08 has to pass for the fixture to build
 * at all, so a regression upstream fails here loudly instead of being mocked
 * past.
 */

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

/** No digits in the names: the award notifications are asserted digit-free. */
const VENDOR_NAMES = ['Acme Networks', 'Northwind Systems', 'Orion Traders', 'Vega Electricals'];

export interface Bidder {
  vendor: Awaited<ReturnType<typeof makeVendor>>;
  contact: TestActor;
}

export interface BidFixture {
  org: Awaited<ReturnType<typeof makeOrganization>>;
  officer: TestActor;
  admin: TestActor;
  /** A second admin, because the first one may be the requester (09 §6). */
  approver: TestActor;
  vendors: Bidder[];
}

export async function makeBidder(name: string): Promise<Bidder> {
  const vendor = await makeVendor(name);
  const contact = await makeUser('VENDOR', { vendorId: vendor.id });
  return { vendor, contact };
}

export async function bidFixture(vendorCount = 3): Promise<BidFixture> {
  const org = await makeOrganization('Meridian Industries');
  const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });
  const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
  const approver = await makeUser('ORG_ADMIN', { organizationId: org.id });

  const vendors: Bidder[] = [];
  for (let i = 0; i < Math.max(3, vendorCount); i++) {
    vendors.push(await makeBidder(VENDOR_NAMES[i] ?? `Supplier ${VENDOR_NAMES.length + i}`));
  }
  return { org, officer, admin, approver, vendors };
}

export const WEIGHTED_CRITERIA = [
  { key: 'price', label: 'Price', weight: 60, direction: 'lower_is_better' as const },
  { key: 'deliveryDays', label: 'Delivery', weight: 20, direction: 'lower_is_better' as const },
  { key: 'quality', label: 'Quality', weight: 20, direction: 'higher_is_better' as const },
];

export const tenderPayload = (overrides: Record<string, unknown> = {}) => ({
  title: 'Supply of managed network switches',
  description: 'Managed L2+ switches with PoE for the Ahmedabad plant network refresh.',
  estimatedBudget: '850000.00',
  deliveryLocation: 'Plot 12, GIDC Estate, Ahmedabad',
  deliveryStateCode: '24',
  deliveryDeadline: hours(24 * 30),
  bidSubmissionDeadline: hours(24),
  evaluationMethod: 'LOWEST_PRICE',
  items: [
    {
      srNo: 1,
      description: 'Managed switch, L2+, PoE',
      unit: 'NOS',
      quantity: '12.000',
      taxRatePercent: '18.00',
      hsnCode: '8517',
      estimatedUnitPrice: '62000.00',
    },
    {
      srNo: 2,
      description: 'SFP+ 10G module',
      unit: 'NOS',
      quantity: '24.000',
      taxRatePercent: '18.00',
      hsnCode: '8517',
    },
  ],
  ...overrides,
});

export async function publishTender(f: BidFixture, overrides: Record<string, unknown> = {}) {
  const draft = await request(app)
    .post('/api/v1/tenders')
    .set(...f.officer.authHeader)
    .send(tenderPayload(overrides));
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

export interface BidOptions {
  prices: string[];
  deliveryDays?: number;
  validityDays?: number;
}

/** Open, price and submit one bid, end to end through the API. */
export async function placeBid(
  f: BidFixture,
  tenderId: string,
  vendorIndex: number,
  options: BidOptions,
) {
  const auth = f.vendors[vendorIndex]!.contact.authHeader;

  const opened = await request(app)
    .post(`/api/v1/vendor/tenders/${tenderId}/quotation`)
    .set(...auth);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const draft = opened.body.data;

  const priced = await request(app)
    .patch(`/api/v1/vendor/quotations/${draft.id}`)
    .set(...auth)
    .send({
      deliveryDays: options.deliveryDays ?? 21,
      validityDays: options.validityDays ?? 45,
      paymentTerms: '30 days from invoice',
      items: draft.items.map((item: { tenderItemId: string; quantity: string }, i: number) => ({
        tenderItemId: item.tenderItemId,
        quantity: item.quantity,
        unitPrice: options.prices[i]!,
      })),
    });
  expect(priced.status, JSON.stringify(priced.body)).toBe(200);

  const submitted = await request(app)
    .post(`/api/v1/vendor/quotations/${draft.id}/submit`)
    .set(...auth);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

  return submitted.body.data;
}

/** Close bidding, which is what sets `bidOpenedAt` and unseals the amounts. */
export const closeBidding = (f: BidFixture, tenderId: string) =>
  request(app)
    .post(`/api/v1/tenders/${tenderId}/close-bidding`)
    .set(...f.officer.authHeader);

export interface OpenedTender {
  f: BidFixture;
  tender: Record<string, unknown> & { id: string };
  bids: (Record<string, unknown> & { id: string; grandTotal: string })[];
}

/**
 * The common starting point: a tender whose bids are open and whose evaluation
 * has been started. `prices` is one price pair per bidding vendor.
 */
export async function openedForEvaluation(
  prices: string[][] = [
    ['58500.00', '8200.00'],
    ['61000.00', '8600.00'],
    ['64000.00', '9000.00'],
  ],
  tenderOverrides: Record<string, unknown> = {},
): Promise<OpenedTender> {
  const f = await bidFixture(prices.length);
  const tender = await publishTender(f, tenderOverrides);

  const bids = [];
  for (let i = 0; i < prices.length; i++) {
    bids.push(
      await placeBid(f, tender.id, i, { prices: prices[i]!, deliveryDays: 14 + i * 7 }),
    );
  }

  await closeBidding(f, tender.id).expect(200);

  const opened = await request(app)
    .post(`/api/v1/tenders/${tender.id}/evaluation/open`)
    .set(...f.officer.authHeader);
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);

  return { f, tender, bids };
}

/** Score every eligible bid on every manual criterion, so `recommend` is unblocked. */
export async function scoreAllBids(
  f: BidFixture,
  tenderId: string,
  mark = 7,
  keys: string[] = ['quality'],
) {
  const bids = await prisma.quotation.findMany({
    where: { tenderId, isLatest: true, status: 'SUBMITTED' },
    select: { id: true },
  });

  for (const bid of bids) {
    const res = await request(app)
      .patch(`/api/v1/quotations/${bid.id}/scores`)
      .set(...f.officer.authHeader)
      .send({ scores: Object.fromEntries(keys.map((key) => [key, mark])) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
}
