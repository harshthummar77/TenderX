import type { Invoice, Payment, Prisma } from '@prisma/client';
import type {
  CompletePaymentInput,
  CreatePaymentInput,
  PaymentQuery,
} from '@tb/shared';
import { BANK_METHODS } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { money, round2, toApi, type Decimal } from '../../lib/money.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { nextNumber } from '../../lib/numbering.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg, scopeToParty, scopeToVendor } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import { createApprovalRequest, registerPaymentDecisionHook } from '../approval/approval.service.js';
import { assertPayable } from '../invoice/payable.js';
import { getSettings } from '../organization/organization.service.js';
import { maybeClosePurchaseOrder, reopenAfterReversal } from './cascade.service.js';
import { transitionPayment } from './payment.stateMachine.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

export type PaymentWithRelations = Payment & {
  invoice: Invoice & { purchaseOrder: { poNumber: string; status: string } };
};

const withRelations = {
  invoice: { include: { purchaseOrder: { select: { poNumber: true, status: true } } } },
} as const;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function loadPayment(actor: Actor, id: string): Promise<PaymentWithRelations> {
  const scope = scopeToParty(actor);
  const payment = await prisma.payment.findFirst({
    where: {
      id,
      ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      ...(scope.vendorId ? { vendorId: scope.vendorId } : {}),
    },
    include: withRelations,
  });
  if (!payment) throw NotFound('Payment');
  return payment as PaymentWithRelations;
}

export async function listPayments(actor: Actor, query: PaymentQuery, side: 'buyer' | 'vendor') {
  const where: Prisma.PaymentWhereInput = {
    ...(side === 'buyer' ? scopeToOrg(actor) : scopeToVendor(actor)),
    ...(query.status ? { status: query.status } : {}),
    ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    ...(query.invoiceId ? { invoiceId: query.invoiceId } : {}),
    ...(query.method ? { method: query.method } : {}),
    ...(query.q ? { paymentNumber: { contains: query.q, mode: 'insensitive' } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: withRelations,
      orderBy: { paidAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.payment.count({ where }),
  ]);

  return {
    rows: rows as PaymentWithRelations[],
    total,
    page: query.page,
    limit: query.limit,
  };
}

/* -------------------------------------------------------------------------- */
/* Recording (plan 13 §4)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `netAmount = gross − tds − retention − other`, computed here and nowhere else.
 *
 * A client-supplied net is not merely ignored — the schema does not accept one,
 * so there is nothing to ignore.
 */
export const netAmountOf = (input: {
  grossAmount: Decimal.Value;
  tdsAmount: Decimal.Value;
  retentionAmount: Decimal.Value;
  otherDeduction: Decimal.Value;
}): Decimal =>
  round2(
    money(input.grossAmount)
      .minus(money(input.tdsAmount))
      .minus(money(input.retentionAmount))
      .minus(money(input.otherDeduction)),
  );

export const deductionsOf = (input: {
  tdsAmount: Decimal.Value;
  retentionAmount: Decimal.Value;
  otherDeduction: Decimal.Value;
}): Decimal =>
  round2(
    money(input.tdsAmount).plus(money(input.retentionAmount)).plus(money(input.otherDeduction)),
  );

/**
 * Record a payment against an approved invoice.
 *
 * The eight validations run **in the order plan 13 §4 states**, because the
 * first failure is the one the user sees. `assertPayable` is first on purpose:
 * it is the README's rule, and "this invoice is not approved for payment" is a
 * more useful answer than "your deductions exceed the gross".
 */
export async function recordPayment(
  actor: Actor,
  input: CreatePaymentInput,
  ctx: RefreshContext,
) {
  if (!actor.organizationId) throw NotFound('Organization');

  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: actor.organizationId },
    include: { purchaseOrder: { select: { id: true, poNumber: true, status: true } } },
  });
  if (!invoice) throw NotFound('Invoice');

  // 1 — the README rule, before anything else.
  assertPayable(invoice);

  // 2.
  const gross = money(input.grossAmount);
  if (!gross.greaterThan(0)) {
    throw BusinessRule('payment.invalid_amount', 'The gross amount must be greater than zero');
  }

  // 3.
  const outstanding = money(invoice.totalAmount).minus(money(invoice.amountPaid));
  if (gross.greaterThan(outstanding)) {
    throw BusinessRule(
      'payment.exceeds_outstanding',
      `Only ${toApi(outstanding)} is outstanding on this invoice`,
    );
  }

  // 4 — strictly less than gross: a payment that pays the vendor nothing is a
  // deduction, and should be recorded as one rather than as a payment.
  const deductions = deductionsOf(input);
  if (deductions.greaterThanOrEqualTo(gross)) {
    throw BusinessRule(
      'payment.deductions_exceed_gross',
      `Deductions of ${toApi(deductions)} are not less than the gross amount of ${toApi(gross)}`,
    );
  }

  // 5.
  const net = netAmountOf(input);

  // 6 — TDS without a section cannot be reported to the tax authority.
  if (money(input.tdsAmount).greaterThan(0) && !input.tdsSection) {
    throw BusinessRule(
      'payment.tds_section_required',
      'A TDS deduction needs the section it was deducted under',
    );
  }

  // 7.
  const paidAt = new Date(input.paidAt);
  if (paidAt.getTime() > Date.now() + 60_000) {
    throw BusinessRule('payment.invalid_date', 'The payment date cannot be in the future');
  }

  // 8 — a bank transfer with nowhere to transfer to.
  const vendor = await prisma.vendor.findUniqueOrThrow({
    where: { id: invoice.vendorId },
    select: { companyName: true, bankAccountNumber: true, bankIfsc: true },
  });
  if ((BANK_METHODS as readonly string[]).includes(input.method)) {
    if (!vendor.bankAccountNumber || !vendor.bankIfsc) {
      throw BusinessRule(
        'payment.vendor_bank_missing',
        `${vendor.companyName} has no bank account on file; a ${input.method} payment cannot be recorded`,
      );
    }
  }

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: actor.organizationId },
  });
  const settings = getSettings(organization);
  const auditActor = auditActorOf(actor, ctx);

  /*
   * Above the threshold a payment is recorded but not yet authorised: it waits
   * for a second person through plan 09's approval engine, exactly like an award
   * or a large invoice.
   */
  const needsApproval = gross.greaterThanOrEqualTo(settings.approvalThresholdAmount);

  const created = await prisma.$transaction(async (tx) => {
    const paymentNumber = await nextNumber(tx, actor.organizationId!, 'PAYMENT', {
      prefix: settings.numberPrefixes.PAYMENT,
    });

    const payment = await tx.payment.create({
      data: {
        organizationId: actor.organizationId!,
        vendorId: invoice.vendorId,
        invoiceId: invoice.id,
        paymentNumber,
        grossAmount: gross.toFixed(2),
        tdsAmount: money(input.tdsAmount).toFixed(2),
        tdsSection: input.tdsSection ?? null,
        retentionAmount: money(input.retentionAmount).toFixed(2),
        otherDeduction: money(input.otherDeduction).toFixed(2),
        netAmount: net.toFixed(2),
        method: input.method,
        referenceNumber: input.referenceNumber ?? null,
        paidAt,
        status: needsApproval ? 'PENDING_APPROVAL' : 'APPROVED',
        recordedById: actor.userId,
        ...(needsApproval ? {} : { approvedById: actor.userId, approvedAt: new Date() }),
        remarks: input.remarks ?? null,
      },
    });

    await writeAudit(tx, {
      action: 'payment.recorded',
      entityType: 'Payment',
      entityId: payment.id,
      severity: 'NOTABLE',
      summary: `${actor.email} recorded payment ${paymentNumber} of ${toApi(gross)} (net ${toApi(net)}) against ${invoice.referenceNumber}`,
      organizationId: actor.organizationId,
      vendorId: invoice.vendorId,
      actor: auditActor,
      after: {
        paymentNumber,
        grossAmount: toApi(gross),
        tdsAmount: toApi(money(input.tdsAmount)),
        tdsSection: input.tdsSection ?? null,
        netAmount: toApi(net),
        method: input.method,
        status: payment.status,
      },
    });

    if (needsApproval) {
      const approval = await createApprovalRequest(tx, {
        organizationId: actor.organizationId!,
        entityType: 'PAYMENT',
        entityId: payment.id,
        amount: gross.toFixed(2),
        requestedById: actor.userId,
        requestNote: input.remarks ?? `Payment ${paymentNumber} against ${invoice.referenceNumber}`,
      });

      const admins = await tx.user.findMany({
        where: {
          organizationId: actor.organizationId!,
          status: 'ACTIVE',
          role: 'ORG_ADMIN',
          id: { not: actor.userId },
        },
        select: { id: true, email: true },
      });

      await notifyMany(
        tx,
        admins.map((u) => u.id),
        {
          type: 'APPROVAL_REQUESTED',
          title: 'Payment approval needed',
          body: `${paymentNumber} of ${toApi(gross)} to ${vendor.companyName} is at or above the approval threshold.`,
          entityType: 'Approval',
          entityId: approval.id,
          link: `/approvals/${approval.id}`,
        },
      );
    }

    const vendorUsers = await tx.user.findMany({
      where: { vendorId: invoice.vendorId, status: 'ACTIVE' },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      vendorUsers.map((u) => u.id),
      {
        type: 'PAYMENT_RECORDED',
        title: `Payment ${paymentNumber} recorded`,
        body: `A payment of ${toApi(gross)} against ${invoice.vendorInvoiceNumber} has been recorded${money(input.tdsAmount).greaterThan(0) ? `, with ${toApi(money(input.tdsAmount))} TDS under section ${input.tdsSection}` : ''}.`,
        entityType: 'Payment',
        entityId: payment.id,
        link: `/vendor/payments`,
      },
    );

    return { payment, vendorUsers };
  });

  emailAfterCommit(
    created.vendorUsers,
    `Payment ${created.payment.paymentNumber} recorded`,
    `Gross ${toApi(gross)}, net ${toApi(net)}.`,
  );

  return loadPayment(actor, created.payment.id);
}

/* -------------------------------------------------------------------------- */
/* Locking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Both ledger-moving paths lock the **payment row first, then the invoice row**,
 * and always in that order. Two transactions that take the same locks in
 * opposite orders deadlock; one order, stated once, is the whole defence.
 *
 * The payment lock is what makes a double-complete fail on the state machine
 * rather than on the payable guard: without it both attempts read APPROVED, and
 * the second is only caught further downstream by the invoice already being PAID
 * — correct in its effect, but a confusing answer to give the user.
 */
async function lockPaymentThenInvoice(
  tx: Prisma.TransactionClient,
  paymentId: string,
): Promise<Payment> {
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${payment.invoiceId}::uuid FOR UPDATE`;
  return payment;
}

/**
 * Waiting out a contending completion takes longer than Prisma's 5s default, and
 * a transaction killed mid-wait leaves the request hanging rather than answering.
 */
const LEDGER_TX_OPTIONS = { timeout: 20_000, maxWait: 15_000 } as const;

/* -------------------------------------------------------------------------- */
/* Completion — where the ledger moves (plan 13 §5)                           */
/* -------------------------------------------------------------------------- */

export async function completePayment(
  actor: Actor,
  id: string,
  input: CompletePaymentInput,
  ctx: RefreshContext,
) {
  await loadPayment(actor, id);
  const auditActor = auditActorOf(actor, ctx);

  const outcome = await prisma.$transaction(async (tx) => {
    /*
     * Both rows locked before anything is read for a decision. Two completions
     * against one invoice would otherwise both read the same `amountPaid`, both
     * pass the outstanding check and both increment — overpaying the vendor and
     * tripping the `invoice_not_overpaid` CHECK constraint, which surfaces as a
     * 500 instead of a clean refusal.
     */
    const payment = await lockPaymentThenInvoice(tx, id);

    // Re-read under the lock: a concurrent completion may have just finished.
    if (payment.status !== 'APPROVED') {
      throw BusinessRule(
        'payment.invalid_transition',
        `Only an APPROVED payment can be completed; this one is ${payment.status}`,
      );
    }

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: payment.invoiceId },
      include: { purchaseOrder: { select: { id: true, poNumber: true, status: true } } },
    });

    // Re-checked against the locked row: approval may be minutes or days old.
    assertPayable(invoice);

    const outstanding = money(invoice.totalAmount).minus(money(invoice.amountPaid));
    if (money(payment.grossAmount).greaterThan(outstanding)) {
      throw BusinessRule(
        'payment.exceeds_outstanding',
        `Only ${toApi(outstanding)} is outstanding on this invoice`,
      );
    }

    /*
     * **`amountPaid` accumulates gross, not net.** The vendor's invoice is
     * discharged when its full gross has been applied, even though less money
     * left the bank — the balance went to the tax authority on the vendor's
     * behalf. Accumulating net would leave every invoice permanently short,
     * which is the classic bug in this domain.
     */
    const newPaid = round2(money(invoice.amountPaid).plus(money(payment.grossAmount)));
    const settled = newPaid.greaterThanOrEqualTo(money(invoice.totalAmount));

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        amountPaid: newPaid.toFixed(2),
        status: settled ? 'PAID' : 'PARTIALLY_PAID',
        paidAt: settled ? new Date() : null,
      },
    });

    const completed = await transitionPayment(tx, payment, 'COMPLETED', auditActor, {
      action: 'payment.completed',
      summary: `Payment ${payment.paymentNumber} of ${toApi(payment.grossAmount)} against ${invoice.referenceNumber} confirmed (ref ${input.referenceNumber})`,
      data: {
        referenceNumber: input.referenceNumber,
        valueDate: input.valueDate ? new Date(input.valueDate) : new Date(),
      },
      after: {
        invoiceAmountPaid: toApi(newPaid),
        invoiceSettled: settled,
        bankReference: input.referenceNumber,
      },
    });

    // The cascade: README step 16, as a consequence rather than a button.
    const cascade = settled
      ? await maybeClosePurchaseOrder(tx, invoice.purchaseOrderId, auditActor)
      : { purchaseOrderClosed: false, tenderClosed: false };

    const vendorUsers = await tx.user.findMany({
      where: { vendorId: payment.vendorId, status: 'ACTIVE' },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      vendorUsers.map((u) => u.id),
      {
        type: 'PAYMENT_COMPLETED',
        title: `Payment ${payment.paymentNumber} released`,
        body: `${toApi(payment.netAmount)} has been paid against ${invoice.vendorInvoiceNumber} (bank reference ${input.referenceNumber}).${settled ? ' The invoice is now fully settled.' : ` ${toApi(money(invoice.totalAmount).minus(newPaid))} remains outstanding.`}`,
        entityType: 'Payment',
        entityId: payment.id,
        link: `/vendor/payments`,
      },
    );

    return { payment: completed, vendorUsers, settled, cascade, invoice };
  }, LEDGER_TX_OPTIONS);

  emailAfterCommit(
    outcome.vendorUsers,
    `Payment ${outcome.payment.paymentNumber} released`,
    `Net ${toApi(outcome.payment.netAmount)} paid. A payment advice is available in the portal.`,
  );

  return loadPayment(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Reversal (plan 13 §6)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The bank returned it.
 *
 * **A completed payment is never edited or deleted.** This marks it FAILED,
 * reverses its effect on the invoice, and reopens whatever the closure cascade
 * had closed. The principle worth stating: financial records are corrected by
 * adding records, never by editing them.
 */
export async function failPayment(actor: Actor, id: string, reason: string, ctx: RefreshContext) {
  await loadPayment(actor, id);
  const auditActor = auditActorOf(actor, ctx);

  const outcome = await prisma.$transaction(async (tx) => {
    const payment = await lockPaymentThenInvoice(tx, id);

    if (payment.status !== 'COMPLETED' && payment.status !== 'APPROVED') {
      throw BusinessRule(
        'payment.invalid_transition',
        `A ${payment.status} payment cannot be marked failed`,
      );
    }

    const reversesLedger = payment.status === 'COMPLETED';
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });

    let cascade = { purchaseOrderClosed: false, tenderClosed: false };

    if (reversesLedger) {
      const restored = round2(money(invoice.amountPaid).minus(money(payment.grossAmount)));
      const floored = restored.isNegative() ? round2(0) : restored;

      /*
       * Back to PARTIALLY_PAID, or all the way to APPROVED_FOR_PAYMENT when the
       * balance returns to zero — an invoice with nothing paid against it is not
       * "partially paid".
       */
      const nextStatus = floored.greaterThan(0) ? 'PARTIALLY_PAID' : 'APPROVED_FOR_PAYMENT';

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { amountPaid: floored.toFixed(2), status: nextStatus, paidAt: null },
      });

      // Undo the closure cascade, since the payment that triggered it is gone.
      cascade = await reopenAfterReversal(
        tx,
        invoice.purchaseOrderId,
        `payment ${payment.paymentNumber} was returned: ${reason}`,
        auditActor,
      );
    }

    const failed = await transitionPayment(tx, payment, 'FAILED', auditActor, {
      action: 'payment.failed',
      // A payment coming back is a financial event an auditor must find.
      severity: 'SECURITY',
      summary: `Payment ${payment.paymentNumber} of ${toApi(payment.grossAmount)} failed: ${reason}`,
      data: { failureReason: reason },
      reason,
      after: {
        ledgerReversed: reversesLedger,
        purchaseOrderReopened: cascade.purchaseOrderClosed,
        tenderReopened: cascade.tenderClosed,
      },
    });

    const recipients = await tx.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { vendorId: payment.vendorId },
          { organizationId: payment.organizationId, role: 'ORG_ADMIN' },
        ],
      },
      select: { id: true, email: true },
    });

    // `PAYMENT_FAILED` is not a NotificationType, so this rides on
    // PAYMENT_RECORDED with its own title rather than inventing an enum value.
    await notifyMany(
      tx,
      recipients.map((u) => u.id),
      {
        type: 'PAYMENT_RECORDED',
        title: `Payment ${payment.paymentNumber} failed`,
        body: `The bank returned ${toApi(payment.grossAmount)} against ${invoice.vendorInvoiceNumber}: ${reason}`,
        entityType: 'Payment',
        entityId: payment.id,
        link: `/payments/${payment.id}`,
      },
    );

    return { payment: failed, recipients };
  }, LEDGER_TX_OPTIONS);

  emailAfterCommit(
    outcome.recipients,
    `Payment ${outcome.payment.paymentNumber} failed`,
    `Reason: ${reason}`,
  );

  return loadPayment(actor, id);
}

export async function cancelPayment(actor: Actor, id: string, reason: string, ctx: RefreshContext) {
  await loadPayment(actor, id);

  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id } });

    // COMPLETED is deliberately absent: money that moved is reversed, not cancelled.
    if (payment.status !== 'PENDING_APPROVAL' && payment.status !== 'APPROVED') {
      throw BusinessRule(
        'payment.invalid_transition',
        `A ${payment.status} payment cannot be cancelled; a completed payment is reversed instead`,
      );
    }

    await transitionPayment(tx, payment, 'CANCELLED', auditActorOf(actor, ctx), {
      action: 'payment.cancelled',
      summary: `${actor.email} cancelled payment ${payment.paymentNumber}: ${reason}`,
      reason,
    });
  });

  return loadPayment(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Plan 09 approval seam                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Teach plan 09's approval engine what a payment decision does.
 *
 * Approving authorises the payment for release; it does **not** complete it.
 * Completion still needs the bank reference, which only exists once the money has
 * actually moved — approving and completing in one step would record a UTR
 * nobody has yet.
 */
export function installPaymentDecisionHook(): void {
  registerPaymentDecisionHook(async (tx, context) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: context.paymentId } });

    if (context.decision === 'APPROVED') {
      await transitionPayment(tx, payment, 'APPROVED', context.actor, {
        action: 'payment.approved',
        summary: `${context.actor.email ?? 'system'} approved payment ${payment.paymentNumber} of ${toApi(payment.grossAmount)} for release`,
        data: { approvedById: context.decidedById, approvedAt: new Date() },
        after: { comment: context.comment },
      });
      return;
    }

    await transitionPayment(tx, payment, 'CANCELLED', context.actor, {
      action: 'payment.cancelled',
      summary: `${context.actor.email ?? 'system'} rejected payment ${payment.paymentNumber}: ${context.comment ?? 'no reason given'}`,
      reason: context.comment,
    });
  });
}
