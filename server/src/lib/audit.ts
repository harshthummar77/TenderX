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

/**
 * Stable JSON: object keys sorted, recursively.
 *
 * `before` and `after` land in a Prisma `Json` column, which is **jsonb** on
 * Postgres — jsonb normalises whitespace and does not preserve key order. A
 * plain JSON.stringify therefore hashes one way on write and another way on
 * read, and every verification fails on an untampered chain. Sorting both sides
 * makes the hash depend on the data, not on the order it happened to be typed.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}

/** Field order is fixed, so the same row always hashes to the same value. */
const canonical = (input: AuditInput, previousHash: string | null, createdAt: string): string =>
  stableStringify([
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

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

export interface ChainVerification {
  valid: boolean;
  checked: number;
  /** Sequence number of the first row whose hash does not reproduce. */
  brokenAt: number | null;
}

/**
 * Walk the chain and recompute every hash. Any edit to history — even one the
 * two Postgres rules somehow allowed — breaks this row and every row after it.
 *
 * Plan 14 exposes this as an endpoint and a screen; plan 05 already reports the
 * boolean on the platform dashboard.
 */
export async function verifyAuditChain(
  client: Prisma.TransactionClient,
  limit?: number,
): Promise<ChainVerification> {
  const rows = await client.activityLog.findMany({
    orderBy: { sequence: 'asc' },
    ...(limit ? { take: limit } : {}),
  });

  let previousHash: string | null = null;
  let checked = 0;

  for (const row of rows) {
    const expected = sha256(
      canonical(
        {
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          summary: row.summary,
          severity: row.severity,
          organizationId: row.organizationId,
          vendorId: row.vendorId,
          actor: { userId: row.actorId },
          before: row.before as Prisma.InputJsonValue | null,
          after: row.after as Prisma.InputJsonValue | null,
        },
        previousHash,
        row.createdAt.toISOString(),
      ),
    );

    checked += 1;
    if (expected !== row.hash || row.previousHash !== previousHash) {
      return { valid: false, checked, brokenAt: Number(row.sequence) };
    }

    previousHash = row.hash;
  }

  return { valid: true, checked, brokenAt: null };
}
