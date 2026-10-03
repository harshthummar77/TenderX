import type { ActivityLog, Prisma } from '@prisma/client';
import type { ActivityDto, ActivityQuery, ChainVerificationDto } from '@tb/shared';
import { verifyAuditChain } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import type { Actor } from '../../middleware/authenticate.js';

/**
 * The activity log read side (plan 14 Part C).
 *
 * Writing is `lib/audit.ts`, called inside every state machine's transaction.
 * This file only reads, and its whole job is deciding **who may see which row**.
 */

export const toActivityDto = (row: ActivityLog): ActivityDto => ({
  id: row.id,
  // BigInt does not survive JSON.stringify, so the sequence crosses as a string.
  sequence: row.sequence.toString(),
  action: row.action,
  entityType: row.entityType,
  entityId: row.entityId,
  summary: row.summary,
  severity: row.severity,
  actor: { id: row.actorId, email: row.actorEmail, role: row.actorRole },
  before: row.before,
  after: row.after,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Visibility (plan 14 §C3).
 *
 * - an org user sees their own organization's rows;
 * - a vendor sees only rows tagged with their vendor id;
 * - **`SECURITY` rows are platform-admin only** — they are the login failures,
 *   the match overrides and the blacklistings, and they routinely name people.
 */
function visibilityFilter(actor: Actor): Prisma.ActivityLogWhereInput {
  if (actor.isPlatformAdmin) return {};

  const party: Prisma.ActivityLogWhereInput[] = [];
  if (actor.organizationId) party.push({ organizationId: actor.organizationId });
  if (actor.vendorId) party.push({ vendorId: actor.vendorId });

  return {
    // A user belonging to no party sees nothing rather than everything.
    ...(party.length > 0 ? { OR: party } : { id: '00000000-0000-0000-0000-000000000000' }),
    severity: { not: 'SECURITY' },
  };
}

export async function listActivity(actor: Actor, query: ActivityQuery) {
  const where: Prisma.ActivityLogWhereInput = {
    ...visibilityFilter(actor),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
    // A non-admin asking for SECURITY gets an empty page, not somebody else's rows.
    ...(query.severity ? { severity: query.severity } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      // Newest first for a feed; `sequence` is the chain order, not display order.
      orderBy: { sequence: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.activityLog.count({ where }),
  ]);

  return { rows: rows.map(toActivityDto), total, page: query.page, limit: query.limit };
}

/** The actor's own trail. No permission needed: these are their actions. */
export async function listOwnActivity(actor: Actor, query: ActivityQuery) {
  const where: Prisma.ActivityLogWhereInput = {
    actorId: actor.userId,
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { sequence: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.activityLog.count({ where }),
  ]);

  return { rows: rows.map(toActivityDto), total, page: query.page, limit: query.limit };
}

/**
 * Walk the chain and recompute every hash.
 *
 * Altering row 400 invalidates 401 and everything after it, and
 * `firstInvalidSequence` points straight at the first row that does not
 * reproduce — tampering is detectable with no external system and no signature
 * authority. Safe to run live on stage: it is a read.
 */
export async function verifyChain(limit?: number): Promise<ChainVerificationDto> {
  const startedAt = Date.now();
  const result = await verifyAuditChain(prisma, limit);

  return {
    valid: result.valid,
    rowsChecked: result.checked,
    durationMs: Date.now() - startedAt,
    firstInvalidSequence: result.brokenAt === null ? null : String(result.brokenAt),
  };
}

/** An entity's own timeline, oldest first — the shape plan 17 renders. */
export async function entityTimeline(actor: Actor, entityType: string, entityId: string) {
  const rows = await prisma.activityLog.findMany({
    where: { ...visibilityFilter(actor), entityType, entityId },
    orderBy: { sequence: 'asc' },
  });
  return rows.map(toActivityDto);
}
