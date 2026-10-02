import type { Prisma, Quotation } from '@prisma/client';
import type { QuotationStatus } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule } from '../../lib/errors.js';

/**
 * The quotation state machine (08 §2).
 *
 *   DRAFT ──submit──► SUBMITTED ──withdraw──► WITHDRAWN
 *     │                   │
 *     │                   ├─(revise before deadline)─► superseded (isLatest=false)
 *     │                   │                             + a new DRAFT revision
 *     │            evaluation outcome
 *     │                   ├──► SHORTLISTED ──► AWARDED
 *     │                   └──► REJECTED / LOST
 *     └──(tender closes while still DRAFT)──► WITHDRAWN, never counted
 *
 * Same rule as the tender machine: **nothing outside this file writes
 * `status`** — every change asserts the transition, updates the row and writes
 * the audit entry in one transaction.
 *
 * The one deliberate exception is `deadline.service.closeBidding`, which sweeps
 * abandoned DRAFTs to WITHDRAWN in bulk when the deadline passes. That is a
 * system action over rows with no actor, written before this module existed.
 */
export const QUOTATION_TRANSITIONS: Record<QuotationStatus, QuotationStatus[]> = {
  DRAFT: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['WITHDRAWN', 'SHORTLISTED', 'REJECTED', 'LOST', 'AWARDED'],
  SHORTLISTED: ['AWARDED', 'LOST', 'REJECTED'],
  WITHDRAWN: [],
  REJECTED: [],
  LOST: [],
  AWARDED: [],
};

export function assertQuotationTransition(from: QuotationStatus, to: QuotationStatus): void {
  if (!QUOTATION_TRANSITIONS[from].includes(to)) {
    throw BusinessRule(
      'quotation.invalid_transition',
      `Cannot move a quotation from ${from} to ${to}`,
    );
  }
}

/** Only a DRAFT is editable — a submitted bid is sealed, and revising forks a new one. */
export function assertQuotationEditable(quotation: Pick<Quotation, 'status'>): void {
  if (quotation.status !== 'DRAFT') {
    throw BusinessRule(
      'quotation.invalid_transition',
      `A ${quotation.status} quotation can no longer be edited`,
    );
  }
}

export interface QuotationTransitionMeta {
  /** Columns that belong to this transition: submittedAt, sealHash, withdrawnAt, ... */
  data?: Prisma.QuotationUpdateInput;
  summary?: string;
  action?: string;
  severity?: 'INFO' | 'NOTABLE' | 'SECURITY';
  reason?: string | null;
  /** Extra audit context. Never put an amount in here while the tender is sealed. */
  after?: Record<string, unknown>;
  /** A quotation carries no organizationId of its own — it comes off the tender. */
  organizationId?: string | null;
}

export async function transitionQuotation(
  tx: Prisma.TransactionClient,
  quotation: Quotation,
  to: QuotationStatus,
  actor: AuditActor,
  meta: QuotationTransitionMeta = {},
): Promise<Quotation> {
  assertQuotationTransition(quotation.status, to);

  const updated = await tx.quotation.update({
    where: { id: quotation.id },
    data: { status: to, ...(meta.data ?? {}) },
  });

  await writeAudit(tx, {
    action: meta.action ?? `quotation.${to.toLowerCase()}`,
    entityType: 'Quotation',
    entityId: quotation.id,
    summary:
      meta.summary ??
      `${actor.email ?? 'system'} moved quotation ${quotation.referenceNumber || quotation.id} to ${to}`,
    severity: meta.severity ?? 'NOTABLE',
    organizationId: meta.organizationId ?? null,
    vendorId: quotation.vendorId,
    actor,
    before: { status: quotation.status },
    after: {
      status: to,
      ...(meta.reason ? { reason: meta.reason } : {}),
      ...(meta.after ?? {}),
    },
  });

  return updated;
}
