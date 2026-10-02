import type { Approval, Prisma, Quotation, Tender } from '@prisma/client';
import type { ApprovalDetailDto, ApprovalDto, ApprovalQuery, DecideInput } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { money, toApi } from '../../lib/money.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import { transitionQuotation } from '../quotation/quotation.stateMachine.js';
import { transitionTender } from '../tender/tender.stateMachine.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

/* -------------------------------------------------------------------------- */
/* Separation of duties (09 §6)                                               */
/* -------------------------------------------------------------------------- */

/**
 * **The rule with no exceptions.**
 *
 * `requestedById === actor.userId` is checked even for an `ORG_ADMIN`. An admin
 * who drafted the tender and recommended a bid cannot then approve it; another
 * admin has to. If the organization has only one admin, they must invite a
 * second — that is the correct real-world answer, and special-casing it away
 * would quietly delete the only control this module exists to provide.
 *
 * The permission layer has already answered "may this role decide at all?" with
 * a 403 (`APPROVAL_DECIDE`, which `ORG_OFFICER` deliberately does not hold).
 * This function answers the different question: "may this *person* decide
 * *this* request?"
 */
export function assertCanDecide(
  approval: Pick<Approval, 'status' | 'requestedById' | 'organizationId'>,
  actor: Actor,
): void {
  if (approval.status !== 'PENDING') {
    throw BusinessRule('approval.already_decided', 'This request has already been decided');
  }
  if (approval.requestedById === actor.userId) {
    throw BusinessRule('approval.self_approval', 'You cannot approve your own request');
  }
  if (actor.organizationId !== approval.organizationId) throw NotFound();
}

/** The same three checks, as a question rather than an assertion, for the UI. */
export function decideBlocker(
  approval: Pick<Approval, 'status' | 'requestedById' | 'organizationId'>,
  actor: Actor,
): string | null {
  try {
    assertCanDecide(approval, actor);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'You cannot decide this request';
  }
}

/* -------------------------------------------------------------------------- */
/* The purchase-order seam (09 §7)                                            */
/* -------------------------------------------------------------------------- */

export interface AwardContext {
  tender: Tender;
  quotation: Quotation;
  actor: AuditActor;
}

/**
 * Plan 10 owns purchase-order generation, and registers it here.
 *
 * It runs **inside the approval transaction** on purpose: §7 requires that if
 * PO generation fails the approval rolls back, so there is no state where a
 * tender is awarded but no purchase order exists. A hook that threw after the
 * commit would produce exactly that orphan.
 *
 * Until plan 10 lands this is unset and the award simply completes. The seam is
 * tested rather than the PO: `evaluation.spec.ts` registers a throwing hook and
 * asserts the whole award rolls back.
 */
export type AwardHook = (tx: Prisma.TransactionClient, context: AwardContext) => Promise<void>;

let awardHook: AwardHook | null = null;

export function registerAwardHook(hook: AwardHook | null): void {
  awardHook = hook;
}

export const hasAwardHook = (): boolean => awardHook !== null;

/* -------------------------------------------------------------------------- */
/* The invoice seam (plan 12 §7)                                                */
/* -------------------------------------------------------------------------- */

export interface InvoiceDecisionContext {
  invoiceId: string;
  decision: 'APPROVED' | 'REJECTED';
  comment: string | null;
  actor: AuditActor;
  decidedById: string;
}

/**
 * Plan 12 owns what an invoice decision *does*, and registers it here.
 *
 * A hook rather than a direct import because `invoice.service` already imports
 * this module for `createApprovalRequest`. Calling back the other way would make
 * the two files a cycle; the seam keeps the dependency one-directional, exactly
 * as the award hook does for plan 10.
 */
export type InvoiceDecisionHook = (
  tx: Prisma.TransactionClient,
  context: InvoiceDecisionContext,
) => Promise<void>;

let invoiceDecisionHook: InvoiceDecisionHook | null = null;

export function registerInvoiceDecisionHook(hook: InvoiceDecisionHook | null): void {
  invoiceDecisionHook = hook;
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export interface ApprovalRequestInput {
  organizationId: string;
  entityType: 'TENDER_AWARD' | 'INVOICE' | 'PAYMENT';
  entityId: string;
  amount: Prisma.Decimal | string | null;
  requestedById: string;
  requestNote: string;
}

/**
 * Called from inside the caller's transaction — the approval row and the state
 * change that needs approving are one unit.
 *
 * The `one_pending_approval` partial unique index (02 §8) means a double-submit
 * produces one row and a duplicate error, not two competing requests.
 */
export async function createApprovalRequest(
  tx: Prisma.TransactionClient,
  input: ApprovalRequestInput,
): Promise<Approval> {
  return tx.approval.create({
    data: {
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      amount: input.amount,
      requestedById: input.requestedById,
      requestNote: input.requestNote,
      status: 'PENDING',
    },
  });
}

/** Every ORG_ADMIN except the requester — the people who can actually act. */
export async function approversFor(
  tx: Prisma.TransactionClient,
  organizationId: string,
  requestedById: string,
) {
  return tx.user.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      role: 'ORG_ADMIN',
      id: { not: requestedById },
    },
    select: { id: true, email: true },
  });
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

interface Person {
  id: string;
  fullName: string;
  email: string;
}

/**
 * `Approval.requestedById` and `decidedById` are plain columns with no Prisma
 * relation — the model deliberately does not join to User, so the approval row
 * survives a user being removed. Names are therefore resolved in one extra
 * query over the ids a page actually contains, not through an `include`.
 */
async function peopleByIdFor(approvals: Approval[]): Promise<Map<string, Person>> {
  const ids = [
    ...new Set(
      approvals.flatMap((approval) =>
        [approval.requestedById, approval.decidedById].filter(
          (id): id is string => id !== null,
        ),
      ),
    ),
  ];
  if (ids.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true, email: true },
  });
  return new Map(users.map((user) => [user.id, user]));
}

const personDto = (person: Person | undefined) =>
  person ? { id: person.id, name: person.fullName, email: person.email } : null;

const toApprovalDto = (
  approval: Approval,
  actor: Actor,
  people: Map<string, Person>,
): ApprovalDto => ({
  id: approval.id,
  entityType: approval.entityType,
  entityId: approval.entityId,
  amount: approval.amount === null ? null : toApi(approval.amount),
  status: approval.status,
  requestedBy: personDto(people.get(approval.requestedById)),
  requestedAt: approval.requestedAt.toISOString(),
  requestNote: approval.requestNote,
  decidedBy: approval.decidedById ? personDto(people.get(approval.decidedById)) : null,
  decidedAt: approval.decidedAt?.toISOString() ?? null,
  decisionComment: approval.decisionComment,
  canDecide: decideBlocker(approval, actor) === null,
  blockedReason: decideBlocker(approval, actor),
});

export async function listApprovals(actor: Actor, query: ApprovalQuery) {
  const where: Prisma.ApprovalWhereInput = {
    ...scopeToOrg(actor),
    ...(query.status ? { status: query.status } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.approval.findMany({
      where,
      // Pending first, then newest: the queue is a to-do list, not an archive.
      orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.approval.count({ where }),
  ]);

  const people = await peopleByIdFor(rows);

  return {
    rows: rows.map((row) => toApprovalDto(row, actor, people)),
    total,
    page: query.page,
    limit: query.limit,
  };
}

async function loadApproval(actor: Actor, id: string) {
  const approval = await prisma.approval.findFirst({
    where: { id, ...scopeToOrg(actor) },
  });
  if (!approval) throw NotFound('Approval');
  return approval;
}

/**
 * The request plus enough of its subject to decide without a second call. An
 * approver should never have to go hunting for what they are approving.
 */
export async function getApproval(actor: Actor, id: string): Promise<ApprovalDetailDto> {
  const approval = await loadApproval(actor, id);
  const base = toApprovalDto(approval, actor, await peopleByIdFor([approval]));

  if (approval.entityType !== 'TENDER_AWARD') {
    return { ...base, tender: null, quotation: null };
  }

  const tender = await prisma.tender.findUnique({ where: { id: approval.entityId } });
  if (!tender) return { ...base, tender: null, quotation: null };

  const quotation = tender.recommendedQuotationId
    ? await prisma.quotation.findUnique({
        where: { id: tender.recommendedQuotationId },
        include: { vendor: { select: { companyName: true } } },
      })
    : null;

  return {
    ...base,
    tender: {
      id: tender.id,
      referenceNumber: tender.referenceNumber || null,
      title: tender.title,
      status: tender.status,
      estimatedBudget: tender.estimatedBudget === null ? null : toApi(tender.estimatedBudget),
      recommendationNote: tender.recommendationNote,
    },
    quotation: quotation
      ? {
          id: quotation.id,
          referenceNumber: quotation.referenceNumber || null,
          vendorName: quotation.vendor.companyName,
          grandTotal: toApi(quotation.grandTotal),
          deliveryDays: quotation.deliveryDays,
          totalScore: quotation.totalScore === null ? null : quotation.totalScore.toFixed(2),
          rank: quotation.rank,
        }
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Decide                                                                     */
/* -------------------------------------------------------------------------- */

interface AwardNotice {
  winnerUserIds: string[];
  loserUserIds: string[];
  requesterIds: string[];
  emails: { email: string }[];
  tenderTitle: string;
  tenderId: string;
}

/**
 * The award branch. Everything here is one transaction with the approval
 * decision: tender, winner, losers, purchase order and notifications either all
 * happen or none do.
 */
async function awardTender(
  tx: Prisma.TransactionClient,
  approval: Approval,
  auditActor: AuditActor,
): Promise<AwardNotice> {
  const who = auditActor.email ?? 'system';

  const tender = await tx.tender.findUniqueOrThrow({ where: { id: approval.entityId } });
  if (!tender.recommendedQuotationId) {
    throw BusinessRule(
      'approval.no_recommendation',
      'This tender has no recommended bid to award',
    );
  }

  const winner = await tx.quotation.findUniqueOrThrow({
    where: { id: tender.recommendedQuotationId },
    include: { vendor: { select: { id: true, companyName: true } } },
  });

  const awarded = await transitionTender(tx, tender, 'AWARDED', auditActor, {
    action: 'tender.awarded',
    summary: `${who} approved the award of ${tender.referenceNumber || tender.title} to ${winner.vendor.companyName}`,
    data: { awardedQuotationId: winner.id, awardedAt: new Date() },
  });

  await transitionQuotation(tx, winner, 'AWARDED', auditActor, {
    action: 'quotation.awarded',
    organizationId: tender.organizationId,
    summary: `Bid ${winner.referenceNumber || winner.id} from ${winner.vendor.companyName} won ${tender.referenceNumber || tender.title}`,
  });

  // Every other live bid loses. Each transition writes its own audit row —
  // a losing vendor is entitled to a record of when and why they lost.
  const losers = await tx.quotation.findMany({
    where: {
      tenderId: tender.id,
      isLatest: true,
      status: { in: ['SUBMITTED', 'SHORTLISTED'] },
      id: { not: winner.id },
    },
  });

  for (const loser of losers) {
    await transitionQuotation(tx, loser, 'LOST', auditActor, {
      action: 'quotation.lost',
      organizationId: tender.organizationId,
      severity: 'INFO',
      summary: `Bid ${loser.referenceNumber || loser.id} was not selected for ${tender.referenceNumber || tender.title}`,
    });
  }

  // Plan 10 fills this in. Inside the transaction so a PO failure rolls the
  // award back rather than leaving an awarded tender with no order (§7).
  if (awardHook) {
    await awardHook(tx, { tender: awarded, quotation: winner, actor: auditActor });
  }

  const winnerUsers = await tx.user.findMany({
    where: { vendorId: winner.vendorId, status: 'ACTIVE' },
    select: { id: true, email: true },
  });
  const loserUsers = await tx.user.findMany({
    where: { vendorId: { in: losers.map((l) => l.vendorId) }, status: 'ACTIVE' },
    select: { id: true, email: true },
  });
  const officers = await tx.user.findMany({
    where: {
      organizationId: tender.organizationId,
      status: 'ACTIVE',
      role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] },
    },
    select: { id: true, email: true },
  });

  // The winner's own total is their own number — they quoted it.
  await notifyMany(
    tx,
    winnerUsers.map((u) => u.id),
    {
      type: 'TENDER_AWARDED',
      title: 'Your bid was accepted',
      body: `${tender.title} has been awarded to you at ${toApi(winner.grandTotal)}. A purchase order follows.`,
      entityType: 'Tender',
      entityId: tender.id,
      link: `/vendor/quotations/${winner.id}`,
    },
  );

  /*
   * **No competitor and no winning amount** (§7). A losing vendor is entitled
   * to know they lost; they are not entitled to know who beat them or by how
   * much. Naming the winner here would hand every bidder a price list for the
   * next tender.
   */
  await notifyMany(
    tx,
    loserUsers.map((u) => u.id),
    {
      type: 'QUOTATION_LOST',
      title: 'Tender awarded to another bidder',
      body: `${tender.title} has been awarded. Your bid was not selected on this occasion. Thank you for participating.`,
      entityType: 'Tender',
      entityId: tender.id,
      link: `/vendor/tenders/${tender.id}`,
    },
  );

  await notifyMany(
    tx,
    officers.map((u) => u.id),
    {
      type: 'APPROVAL_APPROVED',
      title: 'Award approved',
      body: `${who} approved the award of ${tender.title} to ${winner.vendor.companyName}.`,
      entityType: 'Tender',
      entityId: tender.id,
      link: `/tenders/${tender.id}`,
    },
  );

  return {
    winnerUserIds: winnerUsers.map((u) => u.id),
    loserUserIds: loserUsers.map((u) => u.id),
    requesterIds: officers.map((u) => u.id),
    emails: [...winnerUsers, ...officers],
    tenderTitle: tender.title,
    tenderId: tender.id,
  };
}

/**
 * The rejection branch: the tender goes back to the officer with the
 * recommendation cleared, so they can re-evaluate rather than resubmit the same
 * thing. The shortlisted bid returns to the eligible pool — if it stayed
 * SHORTLISTED it would drop out of the `status = 'SUBMITTED'` eligible set and
 * silently skew everyone else's normalisation on the next recalculation.
 */
async function rejectAward(
  tx: Prisma.TransactionClient,
  approval: Approval,
  auditActor: AuditActor,
  comment: string,
): Promise<AwardNotice> {
  const who = auditActor.email ?? 'system';
  const tender = await tx.tender.findUniqueOrThrow({ where: { id: approval.entityId } });

  if (tender.recommendedQuotationId) {
    const shortlisted = await tx.quotation.findUnique({
      where: { id: tender.recommendedQuotationId },
    });
    if (shortlisted && shortlisted.status === 'SHORTLISTED') {
      await transitionQuotation(tx, shortlisted, 'SUBMITTED', auditActor, {
        action: 'quotation.unshortlisted',
        organizationId: tender.organizationId,
        severity: 'INFO',
        summary: `Bid ${shortlisted.referenceNumber || shortlisted.id} returned to the pool after the award was rejected`,
      });
    }
  }

  await transitionTender(tx, tender, 'UNDER_EVALUATION', auditActor, {
    action: 'tender.award_rejected',
    summary: `${who} rejected the award of ${tender.referenceNumber || tender.title}: ${comment}`,
    reason: comment,
    data: {
      recommendedQuotationId: null,
      recommendationNote: null,
      recommendedById: null,
      recommendedAt: null,
    },
  });

  const officers = await tx.user.findMany({
    where: {
      organizationId: tender.organizationId,
      status: 'ACTIVE',
      role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] },
    },
    select: { id: true, email: true },
  });

  await notifyMany(
    tx,
    officers.map((u) => u.id),
    {
      type: 'APPROVAL_REJECTED',
      title: 'Award rejected — re-evaluation needed',
      body: `${who} rejected the award of ${tender.title}: ${comment}`,
      entityType: 'Tender',
      entityId: tender.id,
      link: `/tenders/${tender.id}/comparison`,
    },
  );

  return {
    winnerUserIds: [],
    loserUserIds: [],
    requesterIds: officers.map((u) => u.id),
    emails: officers,
    tenderTitle: tender.title,
    tenderId: tender.id,
  };
}

/**
 * Decide an approval request.
 *
 * The dispatch is a `switch` over three entity types. The enterprise plan
 * decoupled this through an event outbox; that was cut (00 §3), and a switch
 * over three cases is the honest choice at this size.
 */
export async function decideApproval(
  actor: Actor,
  id: string,
  input: DecideInput,
  ctx: RefreshContext,
) {
  // Scoped read first: another organization's approval is a 404, not a 403.
  await loadApproval(actor, id);

  const outcome = await prisma.$transaction(async (tx) => {
    /*
     * Two concurrent approve calls would both read PENDING without this lock,
     * both pass `assertCanDecide`, and both run the award — two purchase orders
     * for one tender. The second now blocks here, then fails
     * `approval.already_decided`.
     */
    await tx.$queryRaw`SELECT id FROM approvals WHERE id = ${id}::uuid FOR UPDATE`;

    const approval = await tx.approval.findUniqueOrThrow({ where: { id } });
    assertCanDecide(approval, actor);

    const decided = await tx.approval.update({
      where: { id },
      data: {
        status: input.decision,
        decidedById: actor.userId,
        decidedAt: new Date(),
        decisionComment: input.comment ?? null,
      },
    });

    let notice: AwardNotice;
    switch (approval.entityType) {
      case 'TENDER_AWARD':
        notice =
          input.decision === 'APPROVED'
            ? await awardTender(tx, approval, auditActorOf(actor, ctx))
            : await rejectAward(tx, approval, auditActorOf(actor, ctx), input.comment ?? '');
        break;

      /*
       * Plan 12 registers what an invoice decision does. The notice shape here
       * is deliberately minimal: the hook owns the transition, the quantity
       * release and the vendor notification, because those belong with the
       * invoice rules rather than with the approval engine.
       */
      case 'INVOICE': {
        if (!invoiceDecisionHook) {
          throw BusinessRule(
            'approval.unsupported_entity',
            'Invoice approvals are not wired up in this build',
          );
        }
        await invoiceDecisionHook(tx, {
          invoiceId: approval.entityId,
          decision: input.decision,
          comment: input.comment ?? null,
          actor: auditActorOf(actor, ctx),
          decidedById: actor.userId,
        });
        notice = {
          winnerUserIds: [],
          loserUserIds: [],
          requesterIds: [],
          emails: [],
          tenderTitle: `invoice ${approval.entityId}`,
          tenderId: approval.entityId,
        };
        break;
      }

      // Plan 13 owns this branch and the payment state machine.
      case 'PAYMENT':
        throw BusinessRule(
          'approval.unsupported_entity',
          `Deciding a ${approval.entityType} approval is not implemented yet`,
        );
    }

    await writeAudit(tx, {
      action: input.decision === 'APPROVED' ? 'approval.approved' : 'approval.rejected',
      entityType: 'Approval',
      entityId: approval.id,
      severity: 'NOTABLE',
      summary: `${actor.email} ${input.decision === 'APPROVED' ? 'approved' : 'rejected'} ${approval.entityType} for ${notice.tenderTitle}${approval.amount === null ? '' : ` (${toApi(approval.amount)})`}`,
      organizationId: approval.organizationId,
      actor: auditActorOf(actor, ctx),
      before: { status: approval.status },
      after: {
        status: input.decision,
        amount: approval.amount === null ? null : toApi(approval.amount),
        ...(input.comment ? { comment: input.comment } : {}),
      },
    });

    return { decided, notice };
  });

  emailAfterCommit(
    outcome.notice.emails,
    input.decision === 'APPROVED'
      ? `Award approved: ${outcome.notice.tenderTitle}`
      : `Award rejected: ${outcome.notice.tenderTitle}`,
    input.comment ?? 'No comment was recorded.',
  );

  return getApproval(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Auto-approval (09 §6)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether an award may clear without a second person.
 *
 * Both conditions must hold: the amount is under the threshold **and** the
 * organization explicitly turned `allowOfficerApproval` on. Default is off, so
 * the demo path goes through a real admin — which is the path worth showing.
 */
export const canAutoApprove = (
  settings: { approvalThresholdAmount: number; allowOfficerApproval: boolean },
  amount: Prisma.Decimal | string,
): boolean =>
  settings.allowOfficerApproval && money(amount).lessThan(settings.approvalThresholdAmount);

/** The actor an automatic decision is recorded under. Never the requester. */
const SYSTEM_ACTOR: AuditActor = { userId: null, email: 'system', role: null };

/**
 * Clear a below-threshold award without a human approver.
 *
 * Called from inside the recommendation transaction, so the recommendation and
 * its automatic approval are one unit. `decidedById` stays **null**: the
 * decision belongs to the organization's own policy, not to the officer who
 * asked for it. Recording it as theirs would be a lie, and it would put their
 * name on an approval that `assertCanDecide` would have refused them.
 */
export async function autoApproveAward(
  tx: Prisma.TransactionClient,
  approval: Approval,
): Promise<void> {
  const comment = 'Auto-approved: below the organization approval threshold';

  await tx.approval.update({
    where: { id: approval.id },
    data: {
      status: 'APPROVED',
      decidedById: null,
      decidedAt: new Date(),
      decisionComment: comment,
    },
  });

  const notice = await awardTender(tx, approval, SYSTEM_ACTOR);

  await writeAudit(tx, {
    action: 'approval.approved',
    entityType: 'Approval',
    entityId: approval.id,
    // SECURITY, not NOTABLE: an award that cleared with nobody signing off is
    // exactly what an auditor should be able to find in one query.
    severity: 'SECURITY',
    summary: `${notice.tenderTitle} was auto-approved below the approval threshold${approval.amount === null ? '' : ` (${toApi(approval.amount)})`}`,
    organizationId: approval.organizationId,
    actor: SYSTEM_ACTOR,
    before: { status: approval.status },
    after: {
      status: 'APPROVED',
      amount: approval.amount === null ? null : toApi(approval.amount),
      comment,
      automatic: true,
    },
  });
}
