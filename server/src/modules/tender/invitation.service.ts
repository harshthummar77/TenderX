import type { SuggestedVendor } from '@tb/shared';
import { STATE_BY_CODE } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { notifyMany } from '../../lib/notify.js';
import { prisma } from '../../lib/prisma.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import { assertEditable } from './tender.stateMachine.js';
import { loadTender } from './tender.service.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

/* -------------------------------------------------------------------------- */
/* Invite / uninvite                                                          */
/* -------------------------------------------------------------------------- */

export async function inviteVendors(
  actor: Actor,
  tenderId: string,
  vendorIds: string[],
  ctx: RefreshContext,
) {
  const tender = await loadTender(actor, tenderId);

  if (tender.status !== 'DRAFT' && tender.status !== 'PUBLISHED') {
    throw BusinessRule(
      'tender.invalid_transition',
      `Cannot invite vendors to a ${tender.status} tender`,
    );
  }

  const vendors = await prisma.vendor.findMany({
    where: { id: { in: vendorIds } },
    select: { id: true, companyName: true, status: true },
  });

  const notApproved = vendors.filter((v) => v.status !== 'APPROVED');
  if (notApproved.length) {
    throw BusinessRule(
      'tender.vendor_not_approved',
      `Only approved vendors can be invited: ${notApproved.map((v) => v.companyName).join(', ')}`,
    );
  }
  if (vendors.length !== vendorIds.length) throw NotFound('Vendor');

  return prisma.$transaction(async (tx) => {
    // Re-inviting an already invited vendor is a no-op, not an error.
    await tx.tenderInvitation.createMany({
      data: vendors.map((vendor) => ({ tenderId, vendorId: vendor.id })),
      skipDuplicates: true,
    });

    await writeAudit(tx, {
      action: 'tender.vendors_invited',
      entityType: 'Tender',
      entityId: tenderId,
      summary: `${actor.email} invited ${vendors.length} vendor(s) to ${tender.referenceNumber ?? tender.title}`,
      organizationId: tender.organizationId,
      actor: auditActorOf(actor, ctx),
      after: { vendorIds: vendors.map((v) => v.id) },
    });

    // A vendor invited to an already-published tender is told immediately;
    // invitations added to a draft are announced at publish.
    if (tender.status === 'PUBLISHED') {
      const users = await tx.user.findMany({
        where: { vendorId: { in: vendors.map((v) => v.id) }, status: 'ACTIVE' },
        select: { id: true },
      });
      await notifyMany(
        tx,
        users.map((u) => u.id),
        {
          type: 'TENDER_INVITED',
          title: 'You have been invited to bid',
          body: `${tender.title} is open for bidding until ${tender.bidSubmissionDeadline.toISOString()}.`,
          entityType: 'Tender',
          entityId: tenderId,
          link: `/vendor/tenders/${tenderId}`,
        },
      );
    }

    return tx.tenderInvitation.findMany({ where: { tenderId } });
  });
}

/** Removing an invitation is a draft-only act: a published tender is an offer. */
export async function uninviteVendor(
  actor: Actor,
  tenderId: string,
  vendorId: string,
  ctx: RefreshContext,
) {
  const tender = await loadTender(actor, tenderId);
  assertEditable(tender);

  const invitation = await prisma.tenderInvitation.findUnique({
    where: { tenderId_vendorId: { tenderId, vendorId } },
  });
  if (!invitation) throw NotFound('Invitation');

  await prisma.$transaction(async (tx) => {
    await tx.tenderInvitation.delete({ where: { id: invitation.id } });
    await writeAudit(tx, {
      action: 'tender.vendor_uninvited',
      entityType: 'Tender',
      entityId: tenderId,
      summary: `${actor.email} removed a vendor from draft "${tender.title}"`,
      organizationId: tender.organizationId,
      actor: auditActorOf(actor, ctx),
      before: { vendorId },
    });
  });
}

export const listInvitations = (tenderId: string) =>
  prisma.tenderInvitation.findMany({
    where: { tenderId },
    include: { vendor: { select: { id: true, companyName: true, status: true, rating: true } } },
    orderBy: { invitedAt: 'asc' },
  });

/* -------------------------------------------------------------------------- */
/* Vendor side                                                                */
/* -------------------------------------------------------------------------- */

/** Reading a tender marks the invitation viewed — the buyer sees engagement. */
export async function markViewed(vendorId: string, tenderId: string) {
  await prisma.tenderInvitation.updateMany({
    where: { tenderId, vendorId, viewedAt: null },
    data: { viewedAt: new Date() },
  });
}

export async function declineInvitation(
  actor: Actor,
  tenderId: string,
  reason: string,
  ctx: RefreshContext,
) {
  if (!actor.vendorId) throw NotFound('Invitation');

  const invitation = await prisma.tenderInvitation.findUnique({
    where: { tenderId_vendorId: { tenderId, vendorId: actor.vendorId } },
    include: { tender: { select: { id: true, title: true, organizationId: true, status: true } } },
  });
  if (!invitation) throw NotFound('Invitation');

  if (invitation.tender.status !== 'PUBLISHED') {
    throw BusinessRule('tender.not_open', 'This tender is no longer open');
  }

  return prisma.$transaction(async (tx) => {
    const declined = await tx.tenderInvitation.update({
      where: { id: invitation.id },
      data: { respondedAt: new Date(), declinedReason: reason },
    });

    await writeAudit(tx, {
      action: 'tender.invitation_declined',
      entityType: 'Tender',
      entityId: tenderId,
      summary: `${actor.email} declined to bid on "${invitation.tender.title}": ${reason}`,
      organizationId: invitation.tender.organizationId,
      vendorId: actor.vendorId,
      actor: auditActorOf(actor, ctx),
      after: { reason },
    });

    const officers = await tx.user.findMany({
      where: {
        organizationId: invitation.tender.organizationId,
        status: 'ACTIVE',
        role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] },
      },
      select: { id: true },
    });
    await notifyMany(
      tx,
      officers.map((o) => o.id),
      {
        type: 'QUOTATION_WITHDRAWN',
        title: 'A vendor declined to bid',
        body: `${invitation.tender.title}: ${reason}`,
        entityType: 'Tender',
        entityId: tenderId,
        link: `/tenders/${tenderId}`,
      },
    );

    return declined;
  });
}

/* -------------------------------------------------------------------------- */
/* Suggested vendors                                                          */
/* -------------------------------------------------------------------------- */

const WEIGHTS = {
  categoryMatch: 40,
  performance: 25,
  pastParticipation: 15,
  sameState: 10,
  recentActivity: 10,
} as const;

/**
 * Rank approved vendors for a tender — and **explain every row**.
 *
 * The `reasons` array costs almost nothing and turns "the computer picked
 * these" into "here is why", which is the difference between a suggestion an
 * officer trusts and one they ignore.
 *
 * A vendor with no history gets the neutral performance component and an
 * `isNew` flag rather than a zero: scoring newcomers zero would permanently
 * freeze them out, which is a real procurement fairness problem.
 */
export async function suggestedVendors(actor: Actor, tenderId: string): Promise<SuggestedVendor[]> {
  const tender = await loadTender(actor, tenderId);

  const vendors = await prisma.vendor.findMany({
    where: { status: 'APPROVED' },
    include: { categories: { select: { id: true, name: true } } },
  });

  const alreadyInvited = new Set(
    (await prisma.tenderInvitation.findMany({ where: { tenderId }, select: { vendorId: true } })).map(
      (i) => i.vendorId,
    ),
  );

  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
  const suggestions: SuggestedVendor[] = [];

  for (const vendor of vendors) {
    if (alreadyInvited.has(vendor.id)) continue;

    const reasons: string[] = [];
    let score = 0;

    // 1. Category match.
    const matched = tender.categoryId
      ? vendor.categories.find((category) => category.id === tender.categoryId)
      : undefined;
    if (matched) {
      score += WEIGHTS.categoryMatch;
      reasons.push(`Matches category: ${matched.name}`);
    }

    // 2. Performance. Null history is neutral, not zero.
    const rating = vendor.rating === null ? null : Number(vendor.rating);
    const isNew = rating === null;
    if (isNew) {
      score += WEIGHTS.performance / 2;
      reasons.push('New vendor — no performance history yet');
    } else {
      score += Math.round((rating / 5) * WEIGHTS.performance);
      reasons.push(`Performance rating ${rating.toFixed(1)} of 5`);
      if (vendor.onTimeDeliveryRate !== null) {
        reasons.push(`On-time delivery ${Number(vendor.onTimeDeliveryRate).toFixed(0)}%`);
      }
    }

    // 3. Past participation in this category.
    const priorQuotes = await prisma.quotation.count({
      where: {
        vendorId: vendor.id,
        status: { not: 'DRAFT' },
        ...(tender.categoryId ? { tender: { categoryId: tender.categoryId } } : {}),
      },
    });
    if (priorQuotes > 0) {
      const wins = await prisma.quotation.count({
        where: {
          vendorId: vendor.id,
          status: 'AWARDED',
          ...(tender.categoryId ? { tender: { categoryId: tender.categoryId } } : {}),
        },
      });
      score += WEIGHTS.pastParticipation;
      reasons.push(
        wins > 0
          ? `Won ${wins} of ${priorQuotes} previous tenders in this category`
          : `Bid on ${priorQuotes} previous tender(s) in this category`,
      );
    }

    // 4. Same state — intra-state supply, CGST+SGST instead of IGST.
    if (vendor.stateCode === tender.deliveryStateCode) {
      score += WEIGHTS.sameState;
      const stateName = STATE_BY_CODE.get(vendor.stateCode)?.name ?? vendor.stateCode;
      reasons.push(`Same state (${stateName}) — intra-state supply, no IGST`);
    }

    // 5. Recent activity.
    const recent = await prisma.quotation.count({
      where: { vendorId: vendor.id, createdAt: { gte: ninetyDaysAgo } },
    });
    if (recent > 0) {
      score += WEIGHTS.recentActivity;
      reasons.push(`Active in the last 90 days (${recent} quotation(s))`);
    } else if (isNew) {
      reasons.push('Recently onboarded');
    }

    suggestions.push({
      vendorId: vendor.id,
      companyName: vendor.companyName,
      score,
      rating,
      isNew,
      reasons,
    });
  }

  return suggestions.sort((a, b) => b.score - a.score);
}
