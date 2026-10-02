import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { registerAwardHook } from '../src/modules/approval/approval.service.js';
import { comparisonToCsv } from '../src/modules/evaluation/export.service.js';
import {
  bidFixture,
  closeBidding,
  openedForEvaluation,
  placeBid,
  publishTender,
  scoreAllBids,
  WEIGHTED_CRITERIA,
  type BidFixture,
} from './helpers/bidding.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Like `quotation.spec.ts`, every test here is a whole tender lifecycle over
 * the Neon test branch — publish, three bids, close, evaluate — so the file
 * needs more than the global 30s.
 */
vi.setConfig({ testTimeout: 120_000 });

const weighted = () => ({ evaluationMethod: 'WEIGHTED_SCORE', criteria: WEIGHTED_CRITERIA });

const comparison = (f: BidFixture, tenderId: string) =>
  request(app)
    .get(`/api/v1/tenders/${tenderId}/comparison`)
    .set(...f.officer.authHeader);

const recommend = (f: BidFixture, tenderId: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/tenders/${tenderId}/recommend`)
    .set(...f.officer.authHeader)
    .send(body);

const JUSTIFICATION =
  'Lowest evaluated cost with the shortest delivery window, and the vendor has completed prior networking orders on time.';

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterEach(() => {
  registerAwardHook(null);
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Sealing still holds                                                        */
/* -------------------------------------------------------------------------- */

describe('the comparison stays sealed', () => {
  /** Plan 09 §11 — and it closes the hole plan 08's leakage test watches for. */
  it('returns 403 before bids are opened, leaking no figure', async () => {
    const f = await bidFixture(3);
    const tender = await publishTender(f);
    const bid = await placeBid(f, tender.id, 0, { prices: ['58500.00', '8200.00'] });

    const res = await comparison(f, tender.id);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('evaluation.bids_sealed');

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(bid.grandTotal);
    expect(body).not.toContain('grandTotal');
  });

  it('refuses to open evaluation while bids are sealed', async () => {
    const f = await bidFixture(3);
    const tender = await publishTender(f);
    await placeBid(f, tender.id, 0, { prices: ['58500.00', '8200.00'] });

    const res = await request(app)
      .post(`/api/v1/tenders/${tender.id}/evaluation/open`)
      .set(...f.officer.authHeader);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('evaluation.bids_sealed');
  });

  it('a vendor cannot read the comparison at all', async () => {
    const { f, tender } = await openedForEvaluation();

    const res = await request(app)
      .get(`/api/v1/tenders/${tender.id}/comparison`)
      .set(...f.vendors[0]!.contact.authHeader);

    expect(res.status).toBe(403);
  });

  it('another organization gets 404, not 403', async () => {
    const { tender } = await openedForEvaluation();
    const rival = await bidFixture(3);

    await request(app)
      .get(`/api/v1/tenders/${tender.id}/comparison`)
      .set(...rival.officer.authHeader)
      .expect(404);
  });
});

/* -------------------------------------------------------------------------- */
/* Opening evaluation                                                         */
/* -------------------------------------------------------------------------- */

describe('opening evaluation', () => {
  it('moves BIDDING_CLOSED to UNDER_EVALUATION', async () => {
    const { tender } = await openedForEvaluation();

    const row = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(row.status).toBe('UNDER_EVALUATION');
    expect(row.bidOpenedAt).toBeTruthy();
  });

  it('refuses to open twice', async () => {
    const { f, tender } = await openedForEvaluation();

    const res = await request(app)
      .post(`/api/v1/tenders/${tender.id}/evaluation/open`)
      .set(...f.officer.authHeader);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('evaluation.invalid_state');
  });
});

/* -------------------------------------------------------------------------- */
/* Comparison matrix                                                          */
/* -------------------------------------------------------------------------- */

describe('comparison matrix', () => {
  it('ranks by price, flags the extremes and summarises the field', async () => {
    const { f, tender, bids } = await openedForEvaluation();

    const res = await comparison(f, tender.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const { bids: rows, summary, items } = res.body.data;
    expect(rows).toHaveLength(3);
    expect(items).toHaveLength(2);

    // Cheapest first under LOWEST_PRICE.
    expect(rows.map((b: { rank: number }) => b.rank)).toEqual([1, 2, 3]);
    expect(rows[0].grandTotal).toBe(bids[0]!.grandTotal);
    expect(rows[0].flags).toContain('lowest_price');
    expect(rows[0].flags).toContain('best_delivery');
    expect(rows[2].flags).toContain('highest_price');

    // Every fixture vendor is brand new, so each carries the flag.
    expect(rows[0].flags).toContain('new_vendor');

    expect(summary.bidCount).toBe(3);
    expect(summary.lowestTotal).toBe(bids[0]!.grandTotal);
    expect(Number(summary.spreadPercent)).toBeGreaterThan(0);
    expect(summary.budgetVariance).not.toBeNull();
  });

  /** The reason the screen is worth building (09 §3). */
  it('marks the cheapest bid on each line separately from the cheapest overall', async () => {
    /*
     * Line 1 is 12 units, line 2 is 24. Vendor 0 wins overall (918,000 taxable)
     * and on line 1, while vendor 1 (948,000) is cheapest on line 2 alone --
     * the exact split the per-line view exists to expose.
     */
    const { f, tender } = await openedForEvaluation([
      ['58500.00', '9000.00'],
      ['65000.00', '7000.00'],
      ['70000.00', '10000.00'],
    ]);

    const res = await comparison(f, tender.id);
    const rows = res.body.data.bids;

    const overallWinner = rows.find((b: { rank: number }) => b.rank === 1);
    expect(overallWinner.flags).toContain('lowest_price');
    expect(overallWinner.lines[0].isLowest).toBe(true);
    // ...but not on the second line.
    expect(overallWinner.lines[1].isLowest).toBe(false);
    expect(Number(overallWinner.lines[1].deltaFromLowestPercent)).toBeGreaterThan(0);

    const lineWinner = rows.find(
      (b: { lines: { isLowest: boolean }[] }) => b.lines[1]!.isLowest,
    );
    expect(lineWinner.rank).not.toBe(1);
  });

  it('surfaces a slow delivery as a deviation without rejecting the bid', async () => {
    const f = await bidFixture(3);
    // A 10-day delivery window, against which 60 days is plainly slow.
    const tender = await publishTender(f, {
      deliveryDeadline: new Date(Date.now() + 34 * 3_600_000).toISOString(),
    });

    await placeBid(f, tender.id, 0, { prices: ['58500.00', '8200.00'], deliveryDays: 60 });
    await placeBid(f, tender.id, 1, { prices: ['61000.00', '8600.00'], deliveryDays: 1 });
    await placeBid(f, tender.id, 2, { prices: ['64000.00', '9000.00'], deliveryDays: 1 });
    await closeBidding(f, tender.id).expect(200);
    await request(app)
      .post(`/api/v1/tenders/${tender.id}/evaluation/open`)
      .set(...f.officer.authHeader)
      .expect(200);

    const res = await comparison(f, tender.id);
    const slow = res.body.data.bids.find((b: { deliveryDays: number }) => b.deliveryDays === 60);

    expect(slow.deviations.join(' ')).toMatch(/Delivery 60 days vs \d+ days required/);
    // Surfaced, never auto-rejecting: it is still ranked and still eligible.
    expect(slow.rank).toBeGreaterThan(0);
    expect(slow.flags).toContain('lowest_price');
  });

  it('weights the columns and sums them to the total', async () => {
    const { f, tender } = await openedForEvaluation(undefined, weighted());
    await scoreAllBids(f, tender.id, 7);

    const res = await comparison(f, tender.id);
    const rows = res.body.data.bids;

    for (const bid of rows) {
      const summed = bid.breakdown.reduce(
        (total: number, column: { weighted: string }) => total + Number(column.weighted),
        0,
      );
      expect(summed).toBeCloseTo(Number(bid.totalScore), 2);
      expect(bid.breakdown.map((c: { weight: number }) => c.weight)).toEqual([60, 20, 20]);
    }

    // Σ weights = 100 for any tender that reaches evaluation.
    const weights = res.body.data.tender.criteria.reduce(
      (total: number, c: { weight: number }) => total + c.weight,
      0,
    );
    expect(weights).toBe(100);
  });

  /** Plan 09 §11, over HTTP this time rather than in the engine. */
  it('withdrawing the lowest bid and recalculating moves every other price score', async () => {
    const f = await bidFixture(3);
    const tender = await publishTender(f, weighted());

    const cheapest = await placeBid(f, tender.id, 0, { prices: ['50000.00', '7000.00'] });
    await placeBid(f, tender.id, 1, { prices: ['60000.00', '8000.00'] });
    await placeBid(f, tender.id, 2, { prices: ['70000.00', '9000.00'] });

    // Withdraw before the deadline, which is the only time it is allowed.
    await request(app)
      .post(`/api/v1/vendor/quotations/${cheapest.id}/withdraw`)
      .set(...f.vendors[0]!.contact.authHeader)
      .send({ reason: 'Component lead times have doubled since we priced this' })
      .expect(200);

    await closeBidding(f, tender.id).expect(200);
    await request(app)
      .post(`/api/v1/tenders/${tender.id}/evaluation/open`)
      .set(...f.officer.authHeader)
      .expect(200);
    await scoreAllBids(f, tender.id, 7);

    const res = await comparison(f, tender.id);

    // The withdrawn bid is excluded from the set entirely...
    expect(res.body.data.bids).toHaveLength(2);
    expect(
      res.body.data.bids.map((b: { quotationId: string }) => b.quotationId),
    ).not.toContain(cheapest.id);

    // ...so the next-cheapest is now the baseline and scores a full 100.
    const best = res.body.data.bids.find((b: { rank: number }) => b.rank === 1);
    expect(best.priceScore).toBe('100.00');
  });

  it('renders with no eligible bids at all', async () => {
    const f = await bidFixture(3);
    const tender = await publishTender(f);
    await placeBid(f, tender.id, 0, { prices: ['58500.00', '8200.00'] });
    await closeBidding(f, tender.id).expect(200);
    await prisma.tender.update({
      where: { id: tender.id },
      data: { status: 'UNDER_EVALUATION' },
    });
    await prisma.quotation.updateMany({
      where: { tenderId: tender.id },
      data: { status: 'REJECTED' },
    });

    const res = await comparison(f, tender.id);

    expect(res.status).toBe(200);
    expect(res.body.data.bids).toEqual([]);
    expect(res.body.data.summary).toMatchObject({ bidCount: 0, lowestTotal: '0.00' });
  });
});

/* -------------------------------------------------------------------------- */
/* Manual scoring                                                             */
/* -------------------------------------------------------------------------- */

describe('manual scoring', () => {
  it('stores a mark and merges later ones', async () => {
    const { f, bids } = await openedForEvaluation(undefined, weighted());

    await request(app)
      .patch(`/api/v1/quotations/${bids[0]!.id}/scores`)
      .set(...f.officer.authHeader)
      .send({ scores: { quality: 8 } })
      .expect(200);

    const res = await request(app)
      .patch(`/api/v1/quotations/${bids[0]!.id}/scores`)
      .set(...f.officer.authHeader)
      .send({ scores: { quality: 6 } });

    expect(res.status).toBe(200);
    expect(res.body.data.scores).toMatchObject({ quality: 6 });
  });

  it('rejects a criterion the tender does not define', async () => {
    const { f, bids } = await openedForEvaluation(undefined, weighted());

    const res = await request(app)
      .patch(`/api/v1/quotations/${bids[0]!.id}/scores`)
      .set(...f.officer.authHeader)
      .send({ scores: { creativity: 9 } });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('evaluation.unknown_criterion');
  });

  it('rejects an automatic criterion — the system owns those', async () => {
    const { f, bids } = await openedForEvaluation(undefined, weighted());

    const res = await request(app)
      .patch(`/api/v1/quotations/${bids[0]!.id}/scores`)
      .set(...f.officer.authHeader)
      .send({ scores: { price: 9 } });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('evaluation.unknown_criterion');
  });

  it('rejects a mark outside 0–10', async () => {
    const { f, bids } = await openedForEvaluation(undefined, weighted());

    const res = await request(app)
      .patch(`/api/v1/quotations/${bids[0]!.id}/scores`)
      .set(...f.officer.authHeader)
      .send({ scores: { quality: 11 } });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  /** An extreme mark is where bias hides, so it costs a sentence. */
  it('demands a written reason for a 0 or a 10', async () => {
    const { f, bids } = await openedForEvaluation(undefined, weighted());

    const bare = await request(app)
      .patch(`/api/v1/quotations/${bids[0]!.id}/scores`)
      .set(...f.officer.authHeader)
      .send({ scores: { quality: 10 } });

    expect(bare.status).toBe(422);
    expect(bare.body.error.code).toBe('evaluation.comment_required');

    const reasoned = await request(app)
      .patch(`/api/v1/quotations/${bids[0]!.id}/scores`)
      .set(...f.officer.authHeader)
      .send({
        scores: { quality: 10 },
        note: 'Sole bidder offering on-site spares and a four-hour response SLA.',
      });

    expect(reasoned.status).toBe(200);
  });

  it('refuses to score a bid once the tender has left evaluation', async () => {
    const { f, tender, bids } = await openedForEvaluation(undefined, weighted());
    await prisma.tender.update({
      where: { id: tender.id },
      data: { status: 'PENDING_APPROVAL' },
    });

    const res = await request(app)
      .patch(`/api/v1/quotations/${bids[0]!.id}/scores`)
      .set(...f.officer.authHeader)
      .send({ scores: { quality: 7 } });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('evaluation.invalid_state');
  });
});

/* -------------------------------------------------------------------------- */
/* Recalculate                                                                */
/* -------------------------------------------------------------------------- */

describe('recalculate', () => {
  it('persists priceScore, technicalScore, totalScore and rank', async () => {
    const { f, tender } = await openedForEvaluation(undefined, weighted());
    await scoreAllBids(f, tender.id, 7);

    const res = await request(app)
      .post(`/api/v1/tenders/${tender.id}/evaluation/recalculate`)
      .set(...f.officer.authHeader);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const rows = await prisma.quotation.findMany({
      where: { tenderId: tender.id, isLatest: true, status: 'SUBMITTED' },
      orderBy: { rank: 'asc' },
    });

    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    for (const row of rows) {
      expect(row.totalScore).not.toBeNull();
      expect(row.priceScore).not.toBeNull();
      expect(row.technicalScore).not.toBeNull();
      expect(row.evaluatedAt).toBeTruthy();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Recommendation                                                             */
/* -------------------------------------------------------------------------- */

describe('recommendation', () => {
  it('shortlists the bid, moves the tender and raises one approval', async () => {
    const { f, tender, bids } = await openedForEvaluation();

    const res = await recommend(f, tender.id, {
      quotationId: bids[0]!.id,
      justification: JUSTIFICATION,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(row.status).toBe('PENDING_APPROVAL');
    expect(row.recommendedQuotationId).toBe(bids[0]!.id);
    expect(row.recommendedById).toBe(f.officer.user.id);
    expect(row.recommendationNote).toBe(JUSTIFICATION);

    const winner = await prisma.quotation.findUniqueOrThrow({ where: { id: bids[0]!.id } });
    expect(winner.status).toBe('SHORTLISTED');

    const approvals = await prisma.approval.findMany({ where: { entityId: tender.id } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.status).toBe('PENDING');
    expect(approvals[0]!.requestedById).toBe(f.officer.user.id);
    expect(approvals[0]!.amount!.toFixed(2)).toBe(bids[0]!.grandTotal);
  });

  it('rejects a justification under 50 characters', async () => {
    const { f, tender, bids } = await openedForEvaluation();

    const res = await recommend(f, tender.id, {
      quotationId: bids[0]!.id,
      justification: 'Cheapest bid.',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  /** Plan 09 §11 — rank 3 with an 80-character justification. */
  it('demands 100 characters to recommend anything but rank 1', async () => {
    const { f, tender, bids } = await openedForEvaluation();
    const eighty = 'A'.repeat(80);
    expect(eighty.length).toBe(80);

    const short = await recommend(f, tender.id, {
      quotationId: bids[2]!.id,
      justification: eighty,
    });

    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('evaluation.override_justification_required');

    const long = await recommend(f, tender.id, {
      quotationId: bids[2]!.id,
      justification: `${eighty} and the vendor is the only one certified for this switch family.`,
    });

    expect(long.status, JSON.stringify(long.body)).toBe(200);

    // The override is what an auditor comes looking for, so it is on the record.
    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'evaluation.recommended', entityId: tender.id },
    });
    expect(JSON.stringify(entry.after)).toContain('"overrodeRanking":true');
  });

  it('blocks a recommendation while a manual criterion is unscored', async () => {
    const { f, tender, bids } = await openedForEvaluation(undefined, weighted());

    // Score two of the three bids, leaving one gap.
    await request(app)
      .patch(`/api/v1/quotations/${bids[0]!.id}/scores`)
      .set(...f.officer.authHeader)
      .send({ scores: { quality: 8 } })
      .expect(200);

    const res = await recommend(f, tender.id, {
      quotationId: bids[0]!.id,
      justification: JUSTIFICATION,
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('evaluation.scores_incomplete');
  });

  it('refuses a bid that is not in the eligible set', async () => {
    const { f, tender } = await openedForEvaluation();
    const other = await openedForEvaluation();

    const res = await recommend(f, tender.id, {
      quotationId: other.bids[0]!.id,
      justification: JUSTIFICATION,
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('evaluation.not_eligible');
  });

  it('notifies the admins who can actually approve, not the requester', async () => {
    const { f, tender, bids } = await openedForEvaluation();

    await recommend(f, tender.id, {
      quotationId: bids[0]!.id,
      justification: JUSTIFICATION,
    }).expect(200);

    const notified = await prisma.notification.findMany({
      where: { type: 'APPROVAL_REQUESTED' },
      select: { userId: true },
    });

    const ids = notified.map((n) => n.userId);
    expect(ids).toContain(f.admin.user.id);
    expect(ids).toContain(f.approver.user.id);
    expect(ids).not.toContain(f.officer.user.id);
  });
});

/* -------------------------------------------------------------------------- */
/* CSV export                                                                 */
/* -------------------------------------------------------------------------- */

describe('CSV export', () => {
  it('serves a BOM-prefixed CSV with one row per vendor', async () => {
    const { f, tender } = await openedForEvaluation();

    const res = await request(app)
      .get(`/api/v1/tenders/${tender.id}/comparison/export`)
      .set(...f.officer.authHeader);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*-comparison\.csv"/);

    const csv = res.text;
    // Excel needs the BOM to read it as UTF-8 rather than the local codepage.
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');

    const header = csv.split('\r\n')[0]!;
    expect(header).toContain('Rank');
    expect(header).toContain('Total score');

    for (const vendor of f.vendors) {
      expect(csv).toContain(vendor.vendor.companyName);
    }
  });

  it('leaves money unquoted so Excel treats it as a number', () => {
    const csv = comparisonToCsv({
      tender: {
        id: 't1',
        referenceNumber: 'TND/2025-26/000012',
        title: 'Switches, "managed"',
        status: 'UNDER_EVALUATION',
        estimatedBudget: '850000.00',
        evaluationMethod: 'LOWEST_PRICE',
        criteria: [],
        bidOpenedAt: null,
        recommendedQuotationId: null,
        awardedQuotationId: null,
      },
      items: [
        { tenderItemId: 'i1', srNo: 1, description: 'Switch', unit: 'NOS', quantity: '12.000' },
      ],
      bids: [
        {
          quotationId: 'q1',
          referenceNumber: 'QTN/2025-26/000001',
          vendor: { id: 'v1', name: 'Saraf & Söhne', rating: null, isNew: true },
          grandTotal: '811792.80',
          deliveryDays: 21,
          validityDays: 45,
          submittedAt: null,
          priceScore: '100.00',
          technicalScore: null,
          totalScore: '100.00',
          rank: 1,
          breakdown: [],
          lines: [
            {
              tenderItemId: 'i1',
              srNo: 1,
              unitPrice: '58500.00',
              lineTotal: '811792.80',
              isLowest: true,
              deltaFromLowestPercent: '0.00',
            },
          ],
          flags: ['lowest_price'],
          deviations: [],
        },
      ],
      summary: {
        bidCount: 1,
        lowestTotal: '811792.80',
        highestTotal: '811792.80',
        averageTotal: '811792.80',
        spreadPercent: '0.00',
        budgetVariance: { amount: '-38207.20', percent: '-4.49' },
      },
    });

    // Numbers bare, so the spreadsheet right-aligns and sums them.
    expect(csv).toContain(',811792.80,');
    // Text quoted, and an embedded quote doubled.
    expect(csv).toContain('"Saraf & Söhne"');
    expect(csv).toContain('"Switches, ""managed"""');
  });
});

/* -------------------------------------------------------------------------- */
/* The purchase-order seam (09 §7)                                            */
/* -------------------------------------------------------------------------- */

describe('award hook', () => {
  /**
   * Plan 10 owns PO generation. What plan 09 owes is the guarantee that it runs
   * inside the award transaction — so this registers a hook and proves both
   * halves: it runs once on a successful award, and a failure takes the whole
   * award down with it rather than leaving an awarded tender with no order.
   */
  it('runs once inside the award transaction', async () => {
    const { f, tender, bids } = await openedForEvaluation();
    await recommend(f, tender.id, {
      quotationId: bids[0]!.id,
      justification: JUSTIFICATION,
    }).expect(200);

    const seen: { tenderId: string; quotationId: string }[] = [];
    registerAwardHook(async (_tx, context) => {
      seen.push({ tenderId: context.tender.id, quotationId: context.quotation.id });
    });

    const approval = await prisma.approval.findFirstOrThrow({ where: { entityId: tender.id } });
    await request(app)
      .post(`/api/v1/approvals/${approval.id}/decide`)
      .set(...f.admin.authHeader)
      .send({ decision: 'APPROVED', comment: 'Approved.' })
      .expect(200);

    expect(seen).toEqual([{ tenderId: tender.id, quotationId: bids[0]!.id }]);
  });

  it('rolls the whole award back when it fails', async () => {
    const { f, tender, bids } = await openedForEvaluation();
    await recommend(f, tender.id, {
      quotationId: bids[0]!.id,
      justification: JUSTIFICATION,
    }).expect(200);

    registerAwardHook(async () => {
      throw new Error('purchase order generation failed');
    });

    const approval = await prisma.approval.findFirstOrThrow({ where: { entityId: tender.id } });
    const res = await request(app)
      .post(`/api/v1/approvals/${approval.id}/decide`)
      .set(...f.admin.authHeader)
      .send({ decision: 'APPROVED', comment: 'Approved.' });

    expect(res.status).toBe(500);

    // Nothing moved: no awarded tender without a purchase order.
    const row = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(row.status).toBe('PENDING_APPROVAL');
    expect(row.awardedQuotationId).toBeNull();

    const stillPending = await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(stillPending.status).toBe('PENDING');

    const winner = await prisma.quotation.findUniqueOrThrow({ where: { id: bids[0]!.id } });
    expect(winner.status).toBe('SHORTLISTED');
  });
});
