import type { AuditActor } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { prisma } from '../../lib/prisma.js';
import { transitionTender } from './tender.stateMachine.js';

/**
 * Deadline handling, shaped by Neon (00 §7B).
 *
 * A. **Lazy close on read (primary).** Every tender list or detail read closes
 *    whatever expired first, so bidding closes within seconds of anyone opening
 *    the app.
 * B. **Cron sweeper (safety net).** The same function org-wide every 15 minutes,
 *    catching tenders nobody looked at. Never per-minute: a job that queries the
 *    database every minute keeps the Neon compute awake 24/7 and burns the whole
 *    free allowance.
 */

const SYSTEM_ACTOR: AuditActor = { userId: null, email: 'system', role: null };

/**
 * Close one tender's bidding.
 *
 * `bidOpenedAt` is the timestamp that unseals the bids in plan 08 — until it is
 * set, no buyer can read a single quoted amount.
 */
export async function closeBidding(tenderId: string, actor: AuditActor = SYSTEM_ACTOR) {
  return prisma.$transaction(async (tx) => {
    const tender = await tx.tender.findUnique({ where: { id: tenderId } });
    if (!tender || tender.status !== 'PUBLISHED') return null;

    const now = new Date();

    // Drafts were never submitted: they do not count as bids, and they must not
    // linger as "live" quotations against a closed tender.
    const abandoned = await tx.quotation.updateMany({
      where: { tenderId, status: 'DRAFT' },
      data: {
        status: 'WITHDRAWN',
        withdrawnAt: now,
        withdrawalReason: 'Not submitted before the bid deadline',
      },
    });

    const submitted = await tx.quotation.count({
      where: { tenderId, status: { in: ['SUBMITTED', 'SHORTLISTED'] } },
    });

    const closed = await transitionTender(tx, tender, 'BIDDING_CLOSED', actor, {
      action: 'tender.bidding_closed',
      summary: `Bidding closed on ${tender.referenceNumber ?? tender.title} with ${submitted} bid(s)`,
      data: { closedAt: now, bidOpenedAt: now },
    });

    const officers = await tx.user.findMany({
      where: { organizationId: tender.organizationId, status: 'ACTIVE', role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] } },
      select: { id: true, email: true },
    });

    // Nobody bid. There is nothing to evaluate, so the tender is cancelled
    // rather than left in a state an officer has to clean up by hand.
    if (submitted === 0) {
      const cancelled = await transitionTender(tx, closed, 'CANCELLED', actor, {
        action: 'tender.cancelled',
        summary: `Tender ${tender.referenceNumber ?? tender.title} cancelled: no bids received`,
        data: { cancelledAt: now, cancellationReason: 'no_bids_received' },
        reason: 'no_bids_received',
      });

      await notifyMany(
        tx,
        officers.map((o) => o.id),
        {
          type: 'TENDER_CANCELLED',
          title: 'Tender cancelled — no bids received',
          body: `${tender.title} closed with no submitted quotations.`,
          entityType: 'Tender',
          entityId: tender.id,
          link: `/tenders/${tender.id}`,
        },
      );

      return { tender: cancelled, submitted, abandoned: abandoned.count, cancelled: true };
    }

    const bidders = await tx.quotation.findMany({
      where: { tenderId, status: { in: ['SUBMITTED', 'SHORTLISTED'] } },
      select: { vendorId: true },
      distinct: ['vendorId'],
    });
    const vendorUsers = await tx.user.findMany({
      where: { vendorId: { in: bidders.map((b) => b.vendorId) }, status: 'ACTIVE' },
      select: { id: true },
    });

    await notifyMany(
      tx,
      [...officers.map((o) => o.id), ...vendorUsers.map((u) => u.id)],
      {
        type: 'TENDER_BIDDING_CLOSED',
        title: 'Bidding closed',
        body: `${tender.title} is now closed for bidding with ${submitted} quotation(s).`,
        entityType: 'Tender',
        entityId: tender.id,
        link: `/tenders/${tender.id}`,
      },
    );

    return { tender: closed, submitted, abandoned: abandoned.count, cancelled: false };
  });
}

/**
 * Close every tender whose deadline has passed. Called at the top of the list
 * and detail reads, and by the cron tick.
 */
export async function closeExpired(organizationId?: string): Promise<number> {
  const expired = await prisma.tender.findMany({
    where: {
      status: 'PUBLISHED',
      bidSubmissionDeadline: { lt: new Date() },
      ...(organizationId ? { organizationId } : {}),
    },
    select: { id: true },
  });

  let closed = 0;
  for (const tender of expired) {
    try {
      if (await closeBidding(tender.id)) closed += 1;
    } catch (err) {
      // One bad tender must not stop a page load or the sweeper.
      logger.error({ err, tenderId: tender.id }, 'Failed to close expired tender');
    }
  }
  return closed;
}

/**
 * "Closing soon" nudges at the 24-hour mark, for vendors who were invited and
 * have not submitted. Deduped on the notification rows themselves — a vendor
 * gets one per tender, not one per sweeper tick.
 */
export async function notifyClosingSoon(): Promise<number> {
  const now = new Date();
  const in24Hours = new Date(now.getTime() + 86_400_000);

  const tenders = await prisma.tender.findMany({
    where: { status: 'PUBLISHED', bidSubmissionDeadline: { gt: now, lt: in24Hours } },
    select: { id: true, title: true, bidSubmissionDeadline: true },
  });

  let sent = 0;

  for (const tender of tenders) {
    const invitations = await prisma.tenderInvitation.findMany({
      where: { tenderId: tender.id, respondedAt: null },
      select: { vendorId: true },
    });

    const submittedVendorIds = new Set(
      (
        await prisma.quotation.findMany({
          where: { tenderId: tender.id, status: { not: 'DRAFT' } },
          select: { vendorId: true },
        })
      ).map((q) => q.vendorId),
    );

    const pendingVendorIds = invitations
      .map((i) => i.vendorId)
      .filter((id) => !submittedVendorIds.has(id));
    if (pendingVendorIds.length === 0) continue;

    const users = await prisma.user.findMany({
      where: { vendorId: { in: pendingVendorIds }, status: 'ACTIVE' },
      select: { id: true, email: true },
    });

    for (const user of users) {
      const already = await prisma.notification.count({
        where: { userId: user.id, type: 'TENDER_CLOSING_SOON', entityId: tender.id },
      });
      if (already > 0) continue;

      await prisma.$transaction(async (tx) => {
        await notifyMany(tx, [user.id], {
          type: 'TENDER_CLOSING_SOON',
          title: 'Bid deadline in under 24 hours',
          body: `${tender.title} closes at ${tender.bidSubmissionDeadline.toISOString()}.`,
          entityType: 'Tender',
          entityId: tender.id,
          link: `/vendor/tenders/${tender.id}`,
        });
      });
      sent += 1;
      emailAfterCommit([user], 'TenderBridge: bid deadline approaching', `${tender.title} closes soon.`);
    }
  }

  return sent;
}

/** One sweeper tick: close what expired, then nudge what is about to. */
export async function runDeadlineSweep(): Promise<{ closed: number; nudged: number }> {
  const closed = await closeExpired();
  const nudged = await notifyClosingSoon();
  if (closed || nudged) logger.info({ closed, nudged }, 'Deadline sweep');
  return { closed, nudged };
}
