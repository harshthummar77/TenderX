import type { Prisma } from '@prisma/client';
import type { AuditSeverity, Role } from '@tb/shared';
import { sha256 } from './crypto.js';

/**
 * Append-only, hash-chained audit log.
 *
 * Every state change writes one of these rows **inside the same transaction as
 * the change** (00 §6, invariant 2). The table itself blocks UPDATE and DELETE
 * through two Postgres rules, so this is the only way history is ever written.
 *
 * Plan 14 adds the verify endpoint and the timeline API on top of this.
 */

export interface AuditActor {
  userId?: string | null;
  email?: string | null;
  role?: Role | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditInput {
  /** Dotted, stable and greppable: "auth.login_failed", "tender.published". */
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  severity?: AuditSeverity;
  organizationId?: string | null;
  vendorId?: string | null;
  actor?: AuditActor | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
}

/** Field order is fixed, so the same row always hashes to the same value. */
const canonical = (input: AuditInput, previousHash: string | null, createdAt: string): string =>
  JSON.stringify([
    input.action,
    input.entityType,
    input.entityId ?? null,
    input.summary,
    input.severity ?? 'INFO',
    input.organizationId ?? null,
    input.vendorId ?? null,
    input.actor?.userId ?? null,
    input.before ?? null,
    input.after ?? null,
    createdAt,
    previousHash,
  ]);

/**
 * Serialises chain writes for the length of the transaction. Two concurrent
 * writers reading the same `previousHash` would fork the chain, and a forked
 * chain fails verification exactly like tampering does.
 */
const CHAIN_LOCK_KEY = 4_242_001;

export async function writeAudit(tx: Prisma.TransactionClient, input: AuditInput) {
  // $executeRaw, not $queryRaw: the function returns void, which Prisma cannot
  // deserialise as a result column.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_KEY}::bigint)`;

  const [previous] = await tx.$queryRaw<{ hash: string }[]>`
    SELECT hash FROM activity_logs ORDER BY sequence DESC LIMIT 1`;
  const previousHash = previous?.hash ?? null;

  const createdAt = new Date();
  const hash = sha256(canonical(input, previousHash, createdAt.toISOString()));

  return tx.activityLog.create({
    data: {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary,
      severity: input.severity ?? 'INFO',
      organizationId: input.organizationId ?? null,
      vendorId: input.vendorId ?? null,
      actorId: input.actor?.userId ?? null,
      actorEmail: input.actor?.email ?? null,
      actorRole: input.actor?.role ?? null,
      ipAddress: input.actor?.ipAddress ?? null,
      userAgent: input.actor?.userAgent ?? null,
      before: input.before ?? undefined,
      after: input.after ?? undefined,
      hash,
      previousHash,
      createdAt,
    },
  });
}
