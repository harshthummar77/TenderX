import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS as P, hasPermission } from '@tb/shared';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { assertCanDecide } from '../src/modules/approval/approval.service.js';
import { actorOf, makeUser } from './helpers/actors.js';
import { openedForEvaluation, type BidFixture } from './helpers/bidding.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Separation of duties (09 §6) — the proof, not the claim.
 *
 * The control is enforced at two layers that answer different questions, and
 * both are tested here because either one alone is a single point of failure:
 *
 *   the role matrix  — may this ROLE decide at all?           403
 *   assertCanDecide  — may this PERSON decide THIS request?   422
 */
vi.setConfig({ testTimeout: 120_000 });

const JUSTIFICATION =
  'Lowest evaluated cost with the shortest delivery window, and the vendor has completed prior networking orders on time.';

/** A tender recommended by the officer, with a pending approval waiting. */
async function recommended() {
  const { f, tender, bids } = await openedForEvaluation();

  await request(app)
    .post(`/api/v1/tenders/${tender.id}/recommend`)
    .set(...f.officer.authHeader)
    .send({ quotationId: bids[0]!.id, justification: JUSTIFICATION })
    .expect(200);

  const approval = await prisma.approval.findFirstOrThrow({ where: { entityId: tender.id } });
  return { f, tender, bids, approval };
}

const decide = (f: BidFixture, approvalId: string, actor: 'officer' | 'admin' | 'approver', body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/approvals/${approvalId}/decide`)
    .set(...f[actor].authHeader)
    .send(body);

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Layer 1 — the role matrix                                                  */
/* -------------------------------------------------------------------------- */

describe('the role matrix stops an officer before any business logic', () => {
  it('ORG_OFFICER does not hold APPROVAL_DECIDE', () => {
    expect(hasPermission('ORG_OFFICER', P.APPROVAL_DECIDE)).toBe(false);
    expect(hasPermission('ORG_ADMIN', P.APPROVAL_DECIDE)).toBe(true);
  });

  /** Plan 09 §11 — a 403 from the permission layer, not a 422 from the service. */
  it('an officer calling decide gets 403', async () => {
    const { f, approval } = await recommended();

    const res = await decide(f, approval.id, 'officer', {
      decision: 'APPROVED',
      comment: 'Approving my own recommendation.',
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('auth.forbidden');

    // And nothing moved.
    const untouched = await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(untouched.status).toBe('PENDING');
  });

  it('an officer cannot even read the approval queue', async () => {
    const { f } = await recommended();

    await request(app)
      .get('/api/v1/approvals')
      .set(...f.officer.authHeader)
      .expect(403);
  });

  it('a vendor cannot reach approvals at all', async () => {
    const { f, approval } = await recommended();

    await request(app)
      .get(`/api/v1/approvals/${approval.id}`)
      .set(...f.vendors[0]!.contact.authHeader)
      .expect(403);
  });
});

/* -------------------------------------------------------------------------- */
/* Layer 2 — assertCanDecide                                                  */
/* -------------------------------------------------------------------------- */

describe('assertCanDecide', () => {
  const approval = {
    status: 'PENDING' as const,
    requestedById: 'requester-id',
    organizationId: 'org-id',
  };

  const actor = (overrides: Record<string, unknown> = {}) => ({
    userId: 'other-id',
    email: 'admin@example.test',
    role: 'ORG_ADMIN' as const,
    organizationId: 'org-id',
    vendorId: null,
    isPlatformAdmin: false,
    ...overrides,
  });

  it('lets a different admin in the same org decide', () => {
    expect(() => assertCanDecide(approval, actor())).not.toThrow();
  });

  it('refuses an already-decided request', () => {
    expect(() => assertCanDecide({ ...approval, status: 'APPROVED' }, actor())).toThrow(
      /already been decided/,
    );
  });

  /** The rule with no exceptions, held even for an ORG_ADMIN. */
  it('refuses the requester, whatever their role', () => {
    expect(() => assertCanDecide(approval, actor({ userId: 'requester-id' }))).toThrow(
      /cannot approve your own request/,
    );
  });

  it('refuses another organization with a 404, not a 403', () => {
    expect(() => assertCanDecide(approval, actor({ organizationId: 'other-org' }))).toThrow(
      /not found/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Over HTTP                                                                  */
/* -------------------------------------------------------------------------- */

describe('self-approval over HTTP', () => {
  /**
   * The case the plan calls out explicitly: an admin who recommends cannot then
   * approve. If the org has only one admin they must invite a second — which is
   * the correct real-world answer, not a special case to code around.
   */
  it('an ORG_ADMIN who recommended cannot approve their own request', async () => {
    const { f, tender, bids } = await openedForEvaluation();

    // This time the ADMIN recommends, so the requester holds APPROVAL_DECIDE.
    await request(app)
      .post(`/api/v1/tenders/${tender.id}/recommend`)
      .set(...f.admin.authHeader)
      .send({ quotationId: bids[0]!.id, justification: JUSTIFICATION })
      .expect(200);

    const approval = await prisma.approval.findFirstOrThrow({ where: { entityId: tender.id } });

    const own = await decide(f, approval.id, 'admin', {
      decision: 'APPROVED',
      comment: 'Approving my own recommendation.',
    });

    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('approval.self_approval');

    // The other admin can, which is the point: a second person, not no person.
    const other = await decide(f, approval.id, 'approver', {
      decision: 'APPROVED',
      comment: 'Reviewed the comparison and the justification. Approved.',
    });

    expect(other.status, JSON.stringify(other.body)).toBe(200);
  });

  it('reports canDecide false with a reason on the requester’s own request', async () => {
    const { f, tender, bids } = await openedForEvaluation();

    await request(app)
      .post(`/api/v1/tenders/${tender.id}/recommend`)
      .set(...f.admin.authHeader)
      .send({ quotationId: bids[0]!.id, justification: JUSTIFICATION })
      .expect(200);

    const approval = await prisma.approval.findFirstOrThrow({ where: { entityId: tender.id } });

    const mine = await request(app)
      .get(`/api/v1/approvals/${approval.id}`)
      .set(...f.admin.authHeader);
    expect(mine.body.data.canDecide).toBe(false);
    expect(mine.body.data.blockedReason).toMatch(/your own request/);

    const theirs = await request(app)
      .get(`/api/v1/approvals/${approval.id}`)
      .set(...f.approver.authHeader);
    expect(theirs.body.data.canDecide).toBe(true);
    expect(theirs.body.data.blockedReason).toBeNull();
  });

  it('another organization cannot see or decide the request', async () => {
    const { approval } = await recommended();
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
      .get(`/api/v1/approvals/${approval.id}`)
      .set(...rivalAdmin.authHeader)
      .expect(404);

    await request(app)
      .post(`/api/v1/approvals/${approval.id}/decide`)
      .set(...rivalAdmin.authHeader)
      .send({ decision: 'APPROVED', comment: 'Not my tender.' })
      .expect(404);

    // Belt and braces: the pure guard refuses the same actor.
    expect(() =>
      assertCanDecide(approval, actorOf(rivalAdmin.user)),
    ).toThrow(/not found/);
  });
});

/* -------------------------------------------------------------------------- */
/* Deciding                                                                   */
/* -------------------------------------------------------------------------- */

describe('approving an award', () => {
  it('awards the tender, marks the loser bids and tells everyone their result', async () => {
    const { f, tender, bids, approval } = await recommended();

    const res = await decide(f, approval.id, 'admin', {
      decision: 'APPROVED',
      comment: 'Approved. Confirm the 3-year warranty in the PO terms.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
    expect(res.body.data.decidedBy.id).toBe(f.admin.user.id);

    const row = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(row.status).toBe('AWARDED');
    expect(row.awardedQuotationId).toBe(bids[0]!.id);
    expect(row.awardedAt).toBeTruthy();

    const winner = await prisma.quotation.findUniqueOrThrow({ where: { id: bids[0]!.id } });
    expect(winner.status).toBe('AWARDED');

    const losers = await prisma.quotation.findMany({
      where: { tenderId: tender.id, id: { not: bids[0]!.id } },
    });
    expect(losers).toHaveLength(2);
    for (const loser of losers) expect(loser.status).toBe('LOST');

    const awarded = await prisma.notification.count({ where: { type: 'TENDER_AWARDED' } });
    const lost = await prisma.notification.count({ where: { type: 'QUOTATION_LOST' } });
    expect(awarded).toBe(1);
    expect(lost).toBe(2);
  });

  /**
   * Plan 09 §7 and §11. A losing vendor is entitled to know they lost; they are
   * not entitled to know who beat them or by how much. Naming the winner would
   * hand every bidder a price list for the next tender.
   */
  it('the losing notification names no competitor and no winning amount', async () => {
    const { f, bids, approval } = await recommended();
    const winnerName = f.vendors[0]!.vendor.companyName;

    await decide(f, approval.id, 'admin', {
      decision: 'APPROVED',
      comment: 'Approved.',
    }).expect(200);

    const lost = await prisma.notification.findMany({ where: { type: 'QUOTATION_LOST' } });
    expect(lost).toHaveLength(2);

    for (const notification of lost) {
      const text = `${notification.title} ${notification.body}`;
      expect(text).not.toContain(winnerName);
      expect(text).not.toContain(bids[0]!.grandTotal);
      // No long digit run at all, so no amount can hide in it.
      expect(text).not.toMatch(/\d{4,}/);
    }
  });

  /** Plan 09 §11 — two concurrent approvals, one award, one refusal. */
  it('turns two concurrent approvals into one award and one already_decided', async () => {
    const { f, tender, approval } = await recommended();

    const [first, second] = await Promise.all([
      decide(f, approval.id, 'admin', { decision: 'APPROVED', comment: 'Approved by admin one.' }),
      decide(f, approval.id, 'approver', {
        decision: 'APPROVED',
        comment: 'Approved by admin two.',
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 422]);
    const loser = first.status === 422 ? first : second;
    expect(loser.body.error.code).toBe('approval.already_decided');

    const rows = await prisma.approval.findMany({ where: { entityId: tender.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('APPROVED');

    const awardedTenders = await prisma.tender.count({
      where: { id: tender.id, status: 'AWARDED' },
    });
    expect(awardedTenders).toBe(1);
  });

  it('records the amount on the audit row at NOTABLE', async () => {
    const { f, bids, approval } = await recommended();

    await decide(f, approval.id, 'admin', {
      decision: 'APPROVED',
      comment: 'Approved.',
    }).expect(200);

    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'approval.approved', entityId: approval.id },
    });
    expect(entry.severity).toBe('NOTABLE');
    expect(JSON.stringify(entry.after)).toContain(bids[0]!.grandTotal);
  });
});

describe('rejecting an award', () => {
  /** Plan 09 §11 — back to UNDER_EVALUATION with the recommendation cleared. */
  it('returns the tender to evaluation and clears the recommendation', async () => {
    const { f, tender, bids, approval } = await recommended();

    const res = await decide(f, approval.id, 'admin', {
      decision: 'REJECTED',
      comment: 'Delivery window is too long for the plant shutdown schedule.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(row.status).toBe('UNDER_EVALUATION');
    expect(row.recommendedQuotationId).toBeNull();
    expect(row.recommendationNote).toBeNull();
    expect(row.recommendedById).toBeNull();
    expect(row.recommendedAt).toBeNull();

    // The bid rejoins the eligible pool, or the next recalculation would
    // silently normalise against a smaller set.
    const bid = await prisma.quotation.findUniqueOrThrow({ where: { id: bids[0]!.id } });
    expect(bid.status).toBe('SUBMITTED');

    const notified = await prisma.notification.count({
      where: { userId: f.officer.user.id, type: 'APPROVAL_REJECTED' },
    });
    expect(notified).toBe(1);
  });

  it('demands a reason of at least 20 characters', async () => {
    const { f, approval } = await recommended();

    const res = await decide(f, approval.id, 'admin', { decision: 'REJECTED', comment: 'No.' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('lets the officer recommend again afterwards', async () => {
    const { f, tender, bids, approval } = await recommended();

    await decide(f, approval.id, 'admin', {
      decision: 'REJECTED',
      comment: 'Prefer the vendor with the shorter delivery window.',
    }).expect(200);

    const again = await request(app)
      .post(`/api/v1/tenders/${tender.id}/recommend`)
      .set(...f.officer.authHeader)
      .send({
        quotationId: bids[1]!.id,
        justification: `${JUSTIFICATION} Re-recommended after the first award was rejected on delivery grounds.`,
      });

    expect(again.status, JSON.stringify(again.body)).toBe(200);

    const row = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(row.status).toBe('PENDING_APPROVAL');
    expect(row.recommendedQuotationId).toBe(bids[1]!.id);
  });
});

describe('the approval queue', () => {
  it('lists pending requests for an admin with canDecide set', async () => {
    const { f } = await recommended();

    const res = await request(app)
      .get('/api/v1/approvals?status=PENDING')
      .set(...f.approver.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].entityType).toBe('TENDER_AWARD');
    expect(res.body.data[0].canDecide).toBe(true);
    expect(res.body.data[0].requestedBy.email).toBe(f.officer.user.email);
  });

  it('carries the tender and the recommended bid on the detail view', async () => {
    const { f, bids, approval } = await recommended();

    const res = await request(app)
      .get(`/api/v1/approvals/${approval.id}`)
      .set(...f.approver.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.tender.status).toBe('PENDING_APPROVAL');
    expect(res.body.data.tender.recommendationNote).toBe(JUSTIFICATION);
    expect(res.body.data.quotation.id).toBe(bids[0]!.id);
    expect(res.body.data.quotation.grandTotal).toBe(bids[0]!.grandTotal);
    expect(res.body.data.quotation.vendorName).toBe(f.vendors[0]!.vendor.companyName);
  });
});
