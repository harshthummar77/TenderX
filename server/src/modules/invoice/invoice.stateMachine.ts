import type { Invoice, Prisma } from '@prisma/client';
import type { InvoiceStatus } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule } from '../../lib/errors.js';

/**
 * The invoice state machine (plan 12 §3).
 *
 *   DRAFT ──submit──► SUBMITTED ──auto-match──► UNDER_REVIEW
 *                                                   │
 *                        ┌──────────────────────────┼─────────────────┐
 *                        ▼                          ▼                 ▼
 *                APPROVED_FOR_PAYMENT           REJECTED      (exception held)
 *                        │
 *                 payment recorded
 *                        ▼
 *                PARTIALLY_PAID ──► PAID
 *
 * `REJECTED → SUBMITTED` is deliberate: a rejected invoice is **corrected and
 * resubmitted, not recreated**, so both attempts stay on one record and the
 * vendor's correction is traceable against what was wrong with it.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['UNDER_REVIEW', 'REJECTED', 'CANCELLED'],
  UNDER_REVIEW: ['APPROVED_FOR_PAYMENT', 'REJECTED'],
  APPROVED_FOR_PAYMENT: ['PARTIALLY_PAID', 'PAID', 'REJECTED'],
  PARTIALLY_PAID: ['PAID'],
  REJECTED: ['SUBMITTED'],
  PAID: [],
  CANCELLED: [],
};

export function assertInvoiceTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!INVOICE_TRANSITIONS[from].includes(to)) {
    throw BusinessRule('invoice.invalid_transition', `Cannot move an invoice from ${from} to ${to}`);
  }
}

/**
 * A DRAFT or a REJECTED invoice is editable; anything else is a live claim.
 *
 * REJECTED is included deliberately. §3 says a rejected invoice is "corrected
 * and resubmitted, not recreated" — and it cannot be corrected if it cannot be
 * edited. Plan §4 lists this route as DRAFT-only; that reading would leave the
 * vendor able only to resubmit the same wrong document, which is not a
 * correction loop. The two attempts still share one record either way.
 */
export function assertInvoiceEditable(invoice: Pick<Invoice, 'status'>): void {
  if (invoice.status !== 'DRAFT' && invoice.status !== 'REJECTED') {
    throw BusinessRule(
      'invoice.invalid_transition',
      `A ${invoice.status} invoice can no longer be edited`,
    );
  }
}

export interface InvoiceTransitionMeta {
  data?: Prisma.InvoiceUpdateInput;
  summary?: string;
  action?: string;
  severity?: 'INFO' | 'NOTABLE' | 'SECURITY';
  reason?: string | null;
  after?: Record<string, unknown>;
}

/** The only way an invoice's `status` changes. */
export async function transitionInvoice(
  tx: Prisma.TransactionClient,
  invoice: Invoice,
  to: InvoiceStatus,
  actor: AuditActor,
  meta: InvoiceTransitionMeta = {},
): Promise<Invoice> {
  assertInvoiceTransition(invoice.status, to);

  const updated = await tx.invoice.update({
    where: { id: invoice.id },
    data: { status: to, ...(meta.data ?? {}) },
  });

  await writeAudit(tx, {
    action: meta.action ?? `invoice.${to.toLowerCase()}`,
    entityType: 'Invoice',
    entityId: invoice.id,
    summary:
      meta.summary ?? `${actor.email ?? 'system'} moved invoice ${invoice.referenceNumber} to ${to}`,
    severity: meta.severity ?? 'NOTABLE',
    organizationId: invoice.organizationId,
    vendorId: invoice.vendorId,
    actor,
    before: { status: invoice.status },
    after: {
      status: to,
      ...(meta.reason ? { reason: meta.reason } : {}),
      ...(meta.after ?? {}),
    },
  });

  return updated;
}
