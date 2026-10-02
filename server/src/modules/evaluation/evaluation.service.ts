import type { Prisma } from '@prisma/client';
import type { ComparisonDto, RecommendInput, ScoreInput } from '@tb/shared';
import { OVERRIDE_JUSTIFICATION_MIN_LENGTH } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { AppError, BusinessRule, NotFound } from '../../lib/errors.js';
import { notifyMany } from '../../lib/notify.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import {
  approversFor,
  autoApproveAward,
  canAutoApprove,
  createApprovalRequest,
} from '../approval/approval.service.js';
import { getSettings } from '../organization/organization.service.js';
import { transitionQuotation } from '../quotation/quotation.stateMachine.js';
import { isSealed } from '../quotation/sealing.js';
import { transitionTender } from '../tender/tender.stateMachine.js';
import {
  buildComparison,
  criteriaOf,
  manualScoresOf,
  scoreEligibleBids,
  type EligibleBid,
  type TenderForComparison,
} from './comparison.service.js';
import { isManual } from './scoring.engine.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

/**
 * **The eligible set: `isLatest = true AND status = 'SUBMITTED'`** (09 §2).
 *
 * Withdrawn, rejected and superseded bids are excluded *before* normalisation,
 * not filtered out of the results afterwards. That distinction is the whole
 * point: dropping the cheapest bid legitimately changes every other bid's price
 * score, because min–max normalisation is relative to the set. An officer who
 * withdraws a bid and recalculates should see the other scores move.
 *
 * A SHORTLISTED bid is deliberately *not* eligible — it is already the
 * recommendation, and a rejected award returns it to SUBMITTED (09 §6).
 */
const ELIGIBLE: Prisma.QuotationWhereInput = { isLatest: true, status: 'SUBMITTED' };

const withBidRelations = {
  vendor: true,
  items: true,
} as const;

/** The tender, org-scoped, with the items the comparison matrix needs. */
async function loadTenderForEvaluation(actor: Actor, id: string): Promise<TenderForComparison> {
  const tender = await prisma.tender.findFirst({
    where: { id, ...scopeToOrg(actor) },
    include: { items: { orderBy: { srNo: 'asc' } } },
  });
  if (!tender) throw NotFound('Tender');
  return tender;
}

const eligibleBids = (tenderId: string): Promise<EligibleBid[]> =>
  prisma.quotation.findMany({
    where: { tenderId, ...ELIGIBLE },
    include: withBidRelations,
    orderBy: { submittedAt: 'asc' },
  }) as Promise<EligibleBid[]>;

/**
 * Sealed bids stay sealed, even from the evaluation screen.
 *
 * A 403 rather than plan 08's sealed-but-present DTO: the comparison matrix has
 * no meaningful sealed form — every column in it is an amount or a score
 * derived from one — so the honest answer is that the screen does not exist
 * yet. The message carries no figure, which keeps plan 08's leakage test green.
 */
function assertOpened(tender: { bidOpenedAt: Date | null }): void {
  if (isSealed(tender)) {
    throw new AppError(
      403,
      'evaluation.bids_sealed',
      'Bids are sealed until bidding closes. There is nothing to compare yet.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

export async function getComparison(actor: Actor, tenderId: string): Promise<ComparisonDto> {
  const tender = await loadTenderForEvaluation(actor, tenderId);
  assertOpened(tender);
  return buildComparison(tender, await eligibleBids(tenderId));
}

/* -------------------------------------------------------------------------- */
/* Open evaluation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `BIDDING_CLOSED → UNDER_EVALUATION`.
 *
 * Guarded on `bidOpenedAt` actually being in the past, not merely set: the
 * column is written when bidding closes, and a clock skew or a hand-edited row
 * must not let an officer start evaluating bids that are still sealed.
 */
export async function openEvaluation(actor: Actor, tenderId: string, ctx: RefreshContext) {
  const tender = await loadTenderForEvaluation(actor, tenderId);
  assertOpened(tender);

  if (tender.status !== 'BIDDING_CLOSED') {
    throw BusinessRule(
      'evaluation.invalid_state',
      `Evaluation opens from BIDDING_CLOSED, not ${tender.status}`,
    );
  }

  const bids = await eligibleBids(tenderId);
  if (bids.length === 0) {
    throw BusinessRule('evaluation.no_bids', 'There are no eligible bids to evaluate');
  }

  await prisma.$transaction(async (tx) => {
    await transitionTender(tx, tender, 'UNDER_EVALUATION', auditActorOf(actor, ctx), {
      action: 'tender.evaluation_opened',
      summary: `${actor.email} opened evaluation of ${tender.referenceNumber || tender.title} with ${bids.length} eligible bid(s)`,
    });
  });

  return getComparison(actor, tenderId);
}

/* -------------------------------------------------------------------------- */
/* Manual scoring                                                             */
/* -------------------------------------------------------------------------- */

/** An extreme mark is where bias hides, so it costs a sentence. */
const EXTREME_SCORES = [0, 10];

export async function scoreQuotation(
  actor: Actor,
  quotationId: string,
  input: ScoreInput,
  ctx: RefreshContext,
) {
  // Scoped through the tender — a quotation carries no organizationId.
  const quotation = await prisma.quotation.findFirst({
    where: { id: quotationId, tender: scopeToOrg(actor) },
    include: { tender: { include: { items: true } }, vendor: true, items: true },
  });
  if (!quotation) throw NotFound('Quotation');

  const tender = quotation.tender;
  assertOpened(tender);

  if (tender.status !== 'UNDER_EVALUATION') {
    throw BusinessRule(
      'evaluation.invalid_state',
      `Scores can only be entered while a tender is UNDER_EVALUATION, not ${tender.status}`,
    );
  }
  if (quotation.status !== 'SUBMITTED') {
    throw BusinessRule(
      'evaluation.not_eligible',
      `A ${quotation.status} bid is not part of the evaluation`,
    );
  }

  const manualKeys = new Set(
    criteriaOf(tender)
      .filter((criterion) => isManual(criterion.key))
      .map((criterion) => criterion.key),
  );

  for (const key of Object.keys(input.scores)) {
    if (!manualKeys.has(key)) {
      throw BusinessRule(
        'evaluation.unknown_criterion',
        `"${key}" is not a manual criterion on this tender`,
      );
    }
  }

  const extremes = Object.entries(input.scores).filter(([, value]) =>
    EXTREME_SCORES.includes(value),
  );
  if (extremes.length > 0 && !input.note) {
    throw BusinessRule(
      'evaluation.comment_required',
      `A score of 0 or 10 needs a written reason (${extremes.map(([key]) => key).join(', ')})`,
    );
  }

  // Merged, not replaced: the UI scores one criterion at a time.
  const merged = { ...(manualScoresOf(quotation) ?? {}), ...input.scores };

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.quotation.update({
      where: { id: quotationId },
      data: {
        criteriaScores: merged as Prisma.InputJsonValue,
        ...(input.note ? { evaluationNote: input.note } : {}),
      },
    });

    await writeAudit(tx, {
      action: 'evaluation.scored',
      entityType: 'Quotation',
      entityId: quotationId,
      severity: 'NOTABLE',
      summary: `${actor.email} scored ${quotation.vendor.companyName} on ${Object.keys(input.scores).join(', ')} for ${tender.referenceNumber || tender.title}`,
      organizationId: tender.organizationId,
      vendorId: quotation.vendorId,
      actor: auditActorOf(actor, ctx),
      before: { scores: manualScoresOf(quotation) },
      after: { scores: merged, ...(input.note ? { note: input.note } : {}) },
    });

    return row;
  });

  return { quotationId: updated.id, scores: merged, note: updated.evaluationNote };
}

/* -------------------------------------------------------------------------- */
/* Recalculate                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Re-run the scoring and persist it.
 *
 * The comparison endpoint computes scores live, so this exists for the things
 * that need them *stored*: the approval snapshot, the CSV, the award, and
 * plan 15's reports. Persisting also makes "why is this bid rank 2?" answerable
 * from the row rather than by re-deriving it.
 */
export async function recalculate(actor: Actor, tenderId: string, ctx: RefreshContext) {
  const tender = await loadTenderForEvaluation(actor, tenderId);
  assertOpened(tender);

  if (tender.status !== 'UNDER_EVALUATION') {
    throw BusinessRule(
      'evaluation.invalid_state',
      `Scoring runs while a tender is UNDER_EVALUATION, not ${tender.status}`,
    );
  }

  const bids = await eligibleBids(tenderId);
  if (bids.length === 0) {
    throw BusinessRule('evaluation.no_bids', 'There are no eligible bids to score');
  }

  const scored = scoreEligibleBids(tender, bids);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    for (const row of scored) {
      await tx.quotation.update({
        where: { id: row.quotationId },
        data: {
          priceScore: row.priceScore === null ? null : row.priceScore.toFixed(2),
          technicalScore: row.technicalScore === null ? null : row.technicalScore.toFixed(2),
          totalScore: row.totalScore.toFixed(2),
          rank: row.rank,
          evaluatedAt: now,
        },
      });
    }

    await writeAudit(tx, {
      action: 'evaluation.recalculated',
      entityType: 'Tender',
      entityId: tenderId,
      summary: `${actor.email} recalculated scores for ${tender.referenceNumber || tender.title} across ${scored.length} bid(s)`,
      organizationId: tender.organizationId,
      actor: auditActorOf(actor, ctx),
      after: {
        method: tender.evaluationMethod,
        ranks: scored.map((row) => ({ quotationId: row.quotationId, rank: row.rank })),
      },
    });
  });

  return getComparison(actor, tenderId);
}

/* -------------------------------------------------------------------------- */
/* Recommendation (09 §5)                                                     */
/* -------------------------------------------------------------------------- */

/** Every manual criterion must be marked on every eligible bid before a recommendation. */
function assertScoresComplete(tender: TenderForComparison, bids: EligibleBid[]): void {
  const manualKeys = criteriaOf(tender)
    .filter((criterion) => isManual(criterion.key))
    .map((criterion) => criterion.key);
  if (manualKeys.length === 0) return;

  const gaps: string[] = [];
  for (const bid of bids) {
    const scores = manualScoresOf(bid) ?? {};
    const missing = manualKeys.filter(
      (key) => scores[key] === undefined || scores[key] === null,
    );
    if (missing.length > 0) gaps.push(`${bid.vendor.companyName}: ${missing.join(', ')}`);
  }

  if (gaps.length > 0) {
    throw BusinessRule(
      'evaluation.scores_incomplete',
      `Every manual criterion must be scored on every bid first — ${gaps.join('; ')}`,
    );
  }
}

/**
 * Recommend a winner, which creates the approval request.
 *
 * One transaction: persist the recommendation → shortlist the bid →
 * `PENDING_APPROVAL` → create the `Approval` → audit → notify the approvers.
 * A recommendation with no approval request attached would be a dead end.
 */
export async function recommend(
  actor: Actor,
  tenderId: string,
  input: RecommendInput,
  ctx: RefreshContext,
) {
  const tender = await loadTenderForEvaluation(actor, tenderId);
  assertOpened(tender);

  if (tender.status !== 'UNDER_EVALUATION') {
    throw BusinessRule(
      'evaluation.invalid_state',
      `A recommendation needs a tender UNDER_EVALUATION, not ${tender.status}`,
    );
  }

  const bids = await eligibleBids(tenderId);
  const chosen = bids.find((bid) => bid.id === input.quotationId);
  if (!chosen) {
    throw BusinessRule(
      'evaluation.not_eligible',
      'That bid is not part of the eligible set for this tender',
    );
  }

  assertScoresComplete(tender, bids);

  const scored = scoreEligibleBids(tender, bids);
  const chosenScore = scored.find((row) => row.quotationId === chosen.id)!;

  /*
   * Overriding the ranking is legitimate — cheapest is not always best — but it
   * has to be argued at length, and the argument lands in the audit log with
   * the officer's name on it. That is the control: not a prohibition, a record.
   */
  if (chosenScore.rank !== 1 && input.justification.length < OVERRIDE_JUSTIFICATION_MIN_LENGTH) {
    throw BusinessRule(
      'evaluation.override_justification_required',
      `Recommending rank ${chosenScore.rank} over rank 1 needs at least ${OVERRIDE_JUSTIFICATION_MIN_LENGTH} characters of justification (got ${input.justification.length})`,
    );
  }

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: tender.organizationId },
  });
  const settings = getSettings(organization);
  const auditActor = auditActorOf(actor, ctx);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await transitionQuotation(tx, chosen, 'SHORTLISTED', auditActor, {
      action: 'quotation.shortlisted',
      organizationId: tender.organizationId,
      summary: `${actor.email} recommended ${chosen.vendor.companyName} for ${tender.referenceNumber || tender.title}`,
    });

    await transitionTender(tx, tender, 'PENDING_APPROVAL', auditActor, {
      action: 'tender.recommended',
      summary: `${actor.email} recommended rank ${chosenScore.rank} (${chosen.vendor.companyName}) for ${tender.referenceNumber || tender.title}`,
      data: {
        recommendedQuotationId: chosen.id,
        recommendationNote: input.justification,
        recommendedById: actor.userId,
        recommendedAt: now,
      },
    });

    const approval = await createApprovalRequest(tx, {
      organizationId: tender.organizationId,
      entityType: 'TENDER_AWARD',
      entityId: tender.id,
      amount: chosen.grandTotal,
      requestedById: actor.userId,
      requestNote: input.justification,
    });

    await writeAudit(tx, {
      action: 'evaluation.recommended',
      entityType: 'Tender',
      entityId: tender.id,
      severity: 'NOTABLE',
      summary: `${actor.email} recommended ${chosen.vendor.companyName} at rank ${chosenScore.rank} for ${tender.referenceNumber || tender.title}`,
      organizationId: tender.organizationId,
      vendorId: chosen.vendorId,
      actor: auditActor,
      after: {
        quotationId: chosen.id,
        rank: chosenScore.rank,
        totalScore: chosenScore.totalScore.toFixed(2),
        approvalId: approval.id,
        justificationLength: input.justification.length,
        // An off-rank recommendation is the thing an auditor looks for.
        overrodeRanking: chosenScore.rank !== 1,
      },
    });

    const approvers = await approversFor(tx, tender.organizationId, actor.userId);
    await notifyMany(
      tx,
      approvers.map((user) => user.id),
      {
        type: 'APPROVAL_REQUESTED',
        title: 'Award approval needed',
        body: `${actor.email} recommended ${chosen.vendor.companyName} for ${tender.title}. Your approval is required.`,
        entityType: 'Approval',
        entityId: approval.id,
        link: `/approvals/${approval.id}`,
      },
    );

    /*
     * `allowOfficerApproval` is off by default, so this is normally skipped and
     * a real admin decides. When an organization does switch it on, the
     * decision is recorded as a *system* decision with no `decidedById` — the
     * requester never approves their own request, not even indirectly (09 §6).
     */
    if (canAutoApprove(settings, chosen.grandTotal)) {
      await autoApproveAward(tx, approval);
    } else if (approvers.length === 0) {
      // Nobody can act on this. Loud in the audit log rather than a request
      // that sits in a queue forever: the organization needs a second admin.
      await writeAudit(tx, {
        action: 'approval.no_approver_available',
        entityType: 'Approval',
        entityId: approval.id,
        severity: 'SECURITY',
        summary: `No second approver exists in ${organization.name}; ${tender.referenceNumber || tender.title} cannot be awarded until one is invited`,
        organizationId: tender.organizationId,
        actor: auditActor,
      });
    }
  });

  return getComparison(actor, tenderId);
}
