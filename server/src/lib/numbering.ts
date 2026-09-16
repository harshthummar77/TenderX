import type { Prisma } from '@prisma/client';
import { fiscalYear, type DocSequenceType } from '@tb/shared';

/**
 * Gapless, fiscal-year-scoped document numbers: `TND/2025-26/000042`.
 *
 * Used by tenders, quotations, POs, GRNs, invoices and payments — write it well
 * once (defect C15: `count() + 1` breaks the moment two officers click at the
 * same time).
 */

export const DEFAULT_PREFIX: Record<DocSequenceType, string> = {
  TENDER: 'TND',
  QUOTATION: 'QTN',
  PURCHASE_ORDER: 'PO',
  GRN: 'GRN',
  INVOICE: 'INV',
  PAYMENT: 'PAY',
};

interface SequenceRow {
  prefix: string;
  nextValue: number;
  padding: number;
}

/**
 * Reserve the next number.
 *
 * - **Atomic.** `INSERT … ON CONFLICT DO UPDATE … RETURNING` is one statement,
 *   so two concurrent publishes get different numbers with no explicit lock and
 *   no read-modify-write race.
 * - **Self-seeding.** The INSERT branch covers an organization whose sequence
 *   row does not exist yet: it stores 2 and returns 1.
 * - **Must run inside the caller's transaction.** Called outside, a rollback
 *   burns the reserved value and the sequence gains a gap — which is the one
 *   thing a gapless sequence may not do.
 *
 * Note the quoted column names: tables are snake_case via `@@map`, but the
 * columns are camelCase (plan 02 §8).
 */
export async function nextNumber(
  tx: Prisma.TransactionClient,
  organizationId: string,
  docType: DocSequenceType,
  options: { at?: Date; prefix?: string } = {},
): Promise<string> {
  const fy = fiscalYear(options.at ?? new Date());
  const seedPrefix = options.prefix ?? DEFAULT_PREFIX[docType];

  const [row] = await tx.$queryRaw<SequenceRow[]>`
    INSERT INTO number_sequences
      (id, "organizationId", "docType", "fiscalYear", prefix, "nextValue", padding, "updatedAt")
    VALUES
      (gen_random_uuid(), ${organizationId}::uuid, ${docType}::"DocSequenceType", ${fy},
       ${seedPrefix}, 2, 6, now())
    ON CONFLICT ("organizationId", "docType", "fiscalYear")
      DO UPDATE SET "nextValue" = number_sequences."nextValue" + 1, "updatedAt" = now()
    RETURNING prefix, "nextValue", padding`;

  if (!row) throw new Error(`Failed to reserve a ${docType} number for organization ${organizationId}`);

  // The row now holds the NEXT value; this call reserved the one before it.
  const reserved = row.nextValue - 1;
  return `${row.prefix}/${fy}/${String(reserved).padStart(row.padding, '0')}`;
}

export { fiscalYear };
