import type { Prisma, Tender } from '@prisma/client';
import type { TenderStatus } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule } from '../../lib/errors.js';

/**
 * The tender state machine.
 *
 * DRAFT -> PUBLISHED -> BIDDING_CLOSED -> UNDER_EVALUATION -> PENDING_APPROVAL
 *   -> AWARDED -> CLOSED, with CANCELLED reachable from every live state and
 *   PENDING_APPROVAL able to fall back to UNDER_EVALUATION on rejection.
 *
 * **The rule that makes this worth having:** nothing outside this file writes
 * `status`. Every change goes through `transitionTender`, which asserts the
 * transition, updates the row and writes the audit entry in the same
 * transaction. `grep -r "data: { status" server/src` should only ever match
 * `*.stateMachine.ts`.
 */
export const TENDER_TRANSITIONS: Record<TenderStatus, TenderStatus[]> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['BIDDING_CLOSED', 'CANCELLED'],
  BIDDING_CLOSED: ['UNDER_EVALUATION', 'CANCELLED'],
  UNDER_EVALUATION: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['AWARDED', 'UNDER_EVALUATION', 'CANCELLED'],
  // UNDER_EVALUATION is the way back: when a winning vendor backs out and the
  // buyer cancels the purchase order (plan 10 §5), the tender returns to
  // evaluation so the runner-up can be awarded. Without it the only options
  // would be cancelling the whole tender and re-running it from scratch.
  AWARDED: ['CLOSED', 'CANCELLED', 'UNDER_EVALUATION'],
  CANCELLED: [],
  CLOSED: [],
};

export function assertTransition(from: TenderStatus, to: TenderStatus): void {
  if (!TENDER_TRANSITIONS[from].includes(to)) {
    throw BusinessRule(
      'tender.invalid_transition',
      `Cannot move a tender from ${from} to ${to}`,
    );
  }
}

/** Only a DRAFT is editable — a published tender is an offer vendors are pricing. */
export function assertEditable(tender: Pick<Tender, 'status'>): void {
  if (tender.status !== 'DRAFT') {
    throw BusinessRule(
      'tender.invalid_transition',
      `A ${tender.status} tender can no longer be edited`,
    );
  }
}

export interface TransitionMeta {
  /** Extra columns that belong to this transition: publishedAt, closedAt, ... */
  data?: Prisma.TenderUpdateInput;
  summary?: string;
  action?: string;
  severity?: 'INFO' | 'NOTABLE' | 'SECURITY';
  reason?: string | null;
}

/**
 * The only way a tender's status changes. Status write + audit row, one
 * transaction, no exceptions (00 §6, invariant 1 and 2).
 */
export async function transitionTender(
  tx: Prisma.TransactionClient,
  tender: Tender,
  to: TenderStatus,
  actor: AuditActor,
  meta: TransitionMeta = {},
): Promise<Tender> {
  assertTransition(tender.status, to);

  const updated = await tx.tender.update({
    where: { id: tender.id },
    data: { status: to, ...(meta.data ?? {}) },
  });

  await writeAudit(tx, {
    action: meta.action ?? `tender.${to.toLowerCase()}`,
    entityType: 'Tender',
    entityId: tender.id,
    summary:
      meta.summary ??
      `${actor.email ?? 'system'} moved tender ${tender.referenceNumber ?? tender.title} to ${to}`,
    severity: meta.severity ?? 'NOTABLE',
    organizationId: tender.organizationId,
    actor,
    before: { status: tender.status },
    after: { status: to, ...(meta.reason ? { reason: meta.reason } : {}) },
  });

  return updated;
}
