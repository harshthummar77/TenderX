import type { Payment, Prisma } from '@prisma/client';
import type { PaymentStatus } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule } from '../../lib/errors.js';
import { toApi } from '../../lib/money.js';

/**
 * The payment state machine (plan 13 §2).
 *
 *   PENDING_APPROVAL ──approve──► APPROVED ──confirm──► COMPLETED
 *          │                         │                     │
 *          └──cancel──► CANCELLED    └──cancel──► CANCELLED └──► FAILED
 *
 * **Only `COMPLETED` moves money in the ledger.** `Invoice.amountPaid` is
 * incremented at the `APPROVED → COMPLETED` transition and nowhere else, so
 * there is exactly one line of code that can change what an invoice has been
 * paid.
 *
 * `COMPLETED → FAILED` is a bank reversal, and `FAILED → APPROVED` is a retry
 * after the bank details are fixed. Note what is missing: no path edits or
 * deletes a completed payment. **Financial records are corrected by adding
 * records, never by editing them** (§6).
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING_APPROVAL: ['APPROVED', 'CANCELLED'],
  APPROVED: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: ['FAILED'],
  FAILED: ['APPROVED'],
  CANCELLED: [],
};

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!PAYMENT_TRANSITIONS[from].includes(to)) {
    throw BusinessRule('payment.invalid_transition', `Cannot move a payment from ${from} to ${to}`);
  }
}

export interface PaymentTransitionMeta {
  data?: Prisma.PaymentUpdateInput;
  summary?: string;
  action?: string;
  severity?: 'INFO' | 'NOTABLE' | 'SECURITY';
  reason?: string | null;
  after?: Record<string, unknown>;
}

/** The only way a payment's `status` changes. */
export async function transitionPayment(
  tx: Prisma.TransactionClient,
  payment: Payment,
  to: PaymentStatus,
  actor: AuditActor,
  meta: PaymentTransitionMeta = {},
): Promise<Payment> {
  assertPaymentTransition(payment.status, to);

  const updated = await tx.payment.update({
    where: { id: payment.id },
    data: { status: to, ...(meta.data ?? {}) },
  });

  await writeAudit(tx, {
    action: meta.action ?? `payment.${to.toLowerCase()}`,
    entityType: 'Payment',
    entityId: payment.id,
    summary:
      meta.summary ??
      `${actor.email ?? 'system'} moved payment ${payment.paymentNumber} to ${to}`,
    // Money moving is never routine.
    severity: meta.severity ?? 'NOTABLE',
    organizationId: payment.organizationId,
    vendorId: payment.vendorId,
    actor,
    before: { status: payment.status },
    after: {
      status: to,
      grossAmount: toApi(payment.grossAmount),
      ...(meta.reason ? { reason: meta.reason } : {}),
      ...(meta.after ?? {}),
    },
  });

  return updated;
}
