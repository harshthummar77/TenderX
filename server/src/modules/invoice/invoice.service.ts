import type { Invoice, Prisma, PurchaseOrder, PurchaseOrderItem } from '@prisma/client';
import type {
  CreateInvoiceInput,
  InvoiceableDto,
  InvoiceItemInput,
  InvoiceQuery,
  UpdateInvoiceInput,
} from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { money, qtyToApi, round2, toApi, ZERO, type Decimal } from '../../lib/money.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { nextNumber } from '../../lib/numbering.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg, scopeToParty, scopeToVendor } from '../../lib/scope.js';
import { computeLineTax, sumPoTotals, type TaxedLine } from '../../lib/tax.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import {
  createApprovalRequest,
  registerInvoiceDecisionHook,
} from '../approval/approval.service.js';
import { getSettings } from '../organization/organization.service.js';
import {
  hasNonOverridableFailure,
  runMatch,
  type MatchCheck,
  type MatchInput,
} from './match.engine.js';
import {
  assertInvoiceEditable,
  transitionInvoice,
} from './invoice.stateMachine.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

export type InvoiceWithRelations = Invoice & {
  items: (Prisma.InvoiceItemGetPayload<object> & {
    purchaseOrderItem?: PurchaseOrderItem | null;
  })[];
  purchaseOrder: PurchaseOrder;
};

const withRelations = {
  items: { include: { purchaseOrderItem: true } },
  purchaseOrder: true,
} as const;

const addDays = (from: Date, days: number): Date => new Date(from.getTime() + days * 86_400_000);

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Both parties read an invoice through their own id; neither by id alone. */
export async function loadInvoice(actor: Actor, id: string): Promise<InvoiceWithRelations> {
  const scope = scopeToParty(actor);
  const invoice = await prisma.invoice.findFirst({
    where: {
      id,
      ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      ...(scope.vendorId ? { vendorId: scope.vendorId } : {}),
    },
    include: withRelations,
  });
  if (!invoice) throw NotFound('Invoice');
  return invoice;
}

export async function listInvoices(actor: Actor, query: InvoiceQuery, side: 'buyer' | 'vendor') {
  const where: Prisma.InvoiceWhereInput = {
    ...(side === 'buyer' ? scopeToOrg(actor) : scopeToVendor(actor)),
    ...(query.status ? { status: query.status } : {}),
    ...(query.matchStatus ? { matchStatus: query.matchStatus } : {}),
    ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    ...(query.purchaseOrderId ? { purchaseOrderId: query.purchaseOrderId } : {}),
    ...(query.overdue
      ? {
          dueDate: { lt: new Date() },
          status: { in: ['APPROVED_FOR_PAYMENT', 'PARTIALLY_PAID'] },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { referenceNumber: { contains: query.q, mode: 'insensitive' } },
            { vendorInvoiceNumber: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: withRelations,
      orderBy: { invoiceDate: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.invoice.count({ where }),
  ]);

  return { rows, total, page: query.page, limit: query.limit };
}

/* -------------------------------------------------------------------------- */
/* Invoiceable prefill (plan 12 §4)                                           */
/* -------------------------------------------------------------------------- */

/** The vendor's own accepted order, with the lines they may bill for. */
async function loadInvoiceablePo(actor: Actor, purchaseOrderId: string) {
  if (!actor.vendorId) throw NotFound('Purchase order');

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, vendorId: actor.vendorId },
    include: { items: { orderBy: { srNo: 'asc' } } },
  });
  if (!po) throw NotFound('Purchase order');
  return po;
}

/**
 * The prefill that makes the screen usable.
 *
 * `invoiceable = acceptedQuantity − invoicedQuantity`. A vendor who accepts the
 * prefill can never trigger a quantity exception; a vendor who overtypes it gets
 * exception 4, which is exactly the demonstration worth having.
 */
export async function getInvoiceable(
  actor: Actor,
  purchaseOrderId: string,
): Promise<InvoiceableDto> {
  const po = await loadInvoiceablePo(actor, purchaseOrderId);
  const warnings: string[] = [];

  const lines = po.items.map((item) => {
    const accepted = money(item.acceptedQuantity);
    const invoiced = money(item.invoicedQuantity);
    const remaining = accepted.minus(invoiced);

    return {
      purchaseOrderItemId: item.id,
      srNo: item.srNo,
      description: item.description,
      hsnCode: item.hsnCode,
      unit: item.unit,
      ordered: qtyToApi(item.quantity),
      accepted: qtyToApi(accepted),
      alreadyInvoiced: qtyToApi(invoiced),
      invoiceable: qtyToApi(remaining.isNegative() ? ZERO : remaining),
      unitPrice: toApi(item.unitPrice),
      taxRatePercent: item.taxRatePercent.toFixed(2),
    };
  });

  const undelivered = po.items.reduce(
    (total, item) => total.plus(money(item.quantity).minus(money(item.receivedQuantity))),
    ZERO,
  );
  if (undelivered.greaterThan(0)) {
    warnings.push(`${qtyToApi(undelivered)} units ordered are not yet received`);
  }

  const rejected = po.items.reduce(
    (total, item) => total.plus(money(item.receivedQuantity).minus(money(item.acceptedQuantity))),
    ZERO,
  );
  if (rejected.greaterThan(0)) {
    warnings.push(`${qtyToApi(rejected)} units were received but rejected and cannot be invoiced`);
  }

  if (po.status !== 'ACCEPTED') {
    warnings.push(`This order is ${po.status} and cannot be invoiced`);
  }

  const anything = lines.some((line) => money(line.invoiceable).greaterThan(0));
  if (!anything) {
    warnings.push('Nothing is invoiceable yet — no goods have been accepted');
  }

  return {
    purchaseOrder: {
      id: po.id,
      poNumber: po.poNumber,
      taxRegime: po.taxRegime,
      status: po.status,
    },
    canInvoice: po.status === 'ACCEPTED' && anything,
    lines,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Pricing — always server-side, always the order's frozen regime             */
/* -------------------------------------------------------------------------- */

/**
 * Recompute every amount from the quantities and the **purchase order's frozen
 * `taxRegime`** (plan 12 §5).
 *
 * Not from the current party addresses: an order issued as intra-state stays
 * intra-state even if the vendor moves state next month, and the invoice against
 * it must agree with it. Re-deriving the regime here would make the match fail
 * on a correct invoice.
 */
function priceInvoiceLines(
  items: InvoiceItemInput[],
  poItems: PurchaseOrderItem[],
  taxRegime: string,
  freight: Decimal.Value,
) {
  const byId = new Map(poItems.map((item) => [item.id, item]));

  const priced = items.map((item, index) => {
    const poItem = byId.get(item.purchaseOrderItemId);
    if (!poItem) {
      throw BusinessRule(
        'invoice.invalid_item',
        `Line ${item.purchaseOrderItemId} is not on this purchase order`,
      );
    }

    const gross = round2(money(item.unitPrice).mul(item.quantity));
    const discount = round2(gross.mul(money(item.discountPercent)).div(100));
    const taxableValue = round2(gross.minus(discount));
    // The buyer's rate off the order line, never the vendor's assertion.
    const tax = computeLineTax(taxableValue, poItem.taxRatePercent, taxRegime as never);

    return {
      purchaseOrderItemId: item.purchaseOrderItemId,
      srNo: poItem.srNo,
      description: poItem.description,
      hsnCode: poItem.hsnCode,
      unit: poItem.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxableValue: taxableValue.toFixed(2),
      taxRatePercent: poItem.taxRatePercent.toFixed(2),
      cgstAmount: tax.cgstAmount.toFixed(2),
      sgstAmount: tax.sgstAmount.toFixed(2),
      igstAmount: tax.igstAmount.toFixed(2),
      lineTotal: round2(
        taxableValue.plus(tax.cgstAmount).plus(tax.sgstAmount).plus(tax.igstAmount),
      ).toFixed(2),
      discountPercent: item.discountPercent,
      index,
    };
  });

  const totals = sumPoTotals(
    priced.map(
      (line): TaxedLine => ({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        taxableValue: line.taxableValue,
        cgstAmount: line.cgstAmount,
        sgstAmount: line.sgstAmount,
        igstAmount: line.igstAmount,
      }),
    ),
    freight,
  );

  return { priced, totals };
}

const totalsData = (totals: ReturnType<typeof sumPoTotals>) => ({
  subtotal: totals.subtotal.toFixed(2),
  discountAmount: totals.discountAmount.toFixed(2),
  taxableAmount: totals.taxableAmount.toFixed(2),
  cgstAmount: totals.cgstAmount.toFixed(2),
  sgstAmount: totals.sgstAmount.toFixed(2),
  igstAmount: totals.igstAmount.toFixed(2),
  freightAmount: totals.freightAmount.toFixed(2),
  roundOff: totals.roundOff.toFixed(2),
  totalAmount: totals.totalAmount.toFixed(2),
});

const itemCreateData = (line: ReturnType<typeof priceInvoiceLines>['priced'][number]) => ({
  purchaseOrderItemId: line.purchaseOrderItemId,
  description: line.description,
  hsnCode: line.hsnCode,
  unit: line.unit,
  quantity: line.quantity,
  unitPrice: line.unitPrice,
  taxableValue: line.taxableValue,
  taxRatePercent: line.taxRatePercent,
  cgstAmount: line.cgstAmount,
  sgstAmount: line.sgstAmount,
  igstAmount: line.igstAmount,
  lineTotal: line.lineTotal,
});

/* -------------------------------------------------------------------------- */
/* Draft create and update                                                    */
/* -------------------------------------------------------------------------- */

/** Guard 4 — duplicate detection, answered as a 422 rather than a Prisma error. */
async function assertNumberUnused(
  client: Prisma.TransactionClient,
  vendorId: string,
  vendorInvoiceNumber: string,
  exceptInvoiceId?: string,
): Promise<void> {
  const existing = await client.invoice.count({
    where: {
      vendorId,
      vendorInvoiceNumber,
      ...(exceptInvoiceId ? { id: { not: exceptInvoiceId } } : {}),
    },
  });
  if (existing > 0) {
    throw BusinessRule(
      'invoice.duplicate_number',
      `You have already raised an invoice numbered ${vendorInvoiceNumber}`,
    );
  }
}

/** Guard 5 — not in the future, not before the order was issued. */
function assertInvoiceDate(invoiceDate: Date, po: PurchaseOrder): void {
  if (invoiceDate.getTime() > Date.now() + 60_000) {
    throw BusinessRule('invoice.invalid_date', 'The invoice date cannot be in the future');
  }
  if (po.issuedAt && invoiceDate.getTime() < po.issuedAt.getTime()) {
    throw BusinessRule(
      'invoice.invalid_date',
      'The invoice cannot be dated before the purchase order was issued',
    );
  }
}

export async function createInvoice(
  actor: Actor,
  purchaseOrderId: string,
  input: CreateInvoiceInput,
  ctx: RefreshContext,
) {
  const po = await loadInvoiceablePo(actor, purchaseOrderId);

  if (po.status !== 'ACCEPTED') {
    throw BusinessRule(
      'invoice.po_not_accepted',
      `An invoice can only be raised against an ACCEPTED order; this one is ${po.status}`,
    );
  }

  const invoiceDate = new Date(input.invoiceDate);
  assertInvoiceDate(invoiceDate, po);
  await assertNumberUnused(prisma, po.vendorId, input.vendorInvoiceNumber);

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: po.organizationId },
  });
  const settings = getSettings(organization);
  const { priced, totals } = priceInvoiceLines(input.items, po.items, po.taxRegime, input.freightAmount);

  const created = await prisma.$transaction(async (tx) => {
    // Reference numbers are the buyer's document register, reserved at creation
    // so the vendor has something to quote in correspondence immediately.
    const referenceNumber = await nextNumber(tx, po.organizationId, 'INVOICE', {
      prefix: settings.numberPrefixes.INVOICE,
    });

    const invoice = await tx.invoice.create({
      data: {
        organizationId: po.organizationId,
        vendorId: po.vendorId,
        purchaseOrderId: po.id,
        vendorInvoiceNumber: input.vendorInvoiceNumber,
        referenceNumber,
        invoiceDate,
        dueDate: addDays(invoiceDate, settings.defaultPaymentTermDays),
        ...totalsData(totals),
        status: 'DRAFT',
        matchStatus: 'NOT_RUN',
        items: { create: priced.map(itemCreateData) },
      },
      include: withRelations,
    });

    await writeAudit(tx, {
      action: 'invoice.drafted',
      entityType: 'Invoice',
      entityId: invoice.id,
      severity: 'INFO',
      summary: `${actor.email} drafted invoice ${referenceNumber} against ${po.poNumber} for ${toApi(invoice.totalAmount)}`,
      organizationId: po.organizationId,
      vendorId: po.vendorId,
      actor: auditActorOf(actor, ctx),
      after: { referenceNumber, items: priced.length, totalAmount: toApi(invoice.totalAmount) },
    });

    return invoice;
  });

  return loadInvoice(actor, created.id);
}

export async function updateInvoice(
  actor: Actor,
  id: string,
  input: UpdateInvoiceInput,
  ctx: RefreshContext,
) {
  const invoice = await loadInvoice(actor, id);
  assertInvoiceEditable(invoice);

  const po = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: invoice.purchaseOrderId },
    include: { items: true },
  });

  if (input.invoiceDate) assertInvoiceDate(new Date(input.invoiceDate), po);
  if (input.vendorInvoiceNumber) {
    await assertNumberUnused(prisma, invoice.vendorId, input.vendorInvoiceNumber, id);
  }

  await prisma.$transaction(async (tx) => {
    let data: Prisma.InvoiceUpdateInput = {
      ...(input.vendorInvoiceNumber ? { vendorInvoiceNumber: input.vendorInvoiceNumber } : {}),
      ...(input.invoiceDate ? { invoiceDate: new Date(input.invoiceDate) } : {}),
    };

    if (input.items || input.freightAmount !== undefined) {
      const items: InvoiceItemInput[] =
        input.items ??
        invoice.items.map((item) => ({
          purchaseOrderItemId: item.purchaseOrderItemId,
          quantity: item.quantity.toFixed(3),
          unitPrice: item.unitPrice.toFixed(2),
          discountPercent: '0.00',
        }));

      const { priced, totals } = priceInvoiceLines(
        items,
        po.items,
        po.taxRegime,
        input.freightAmount ?? invoice.freightAmount,
      );

      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      data = { ...data, ...totalsData(totals), items: { create: priced.map(itemCreateData) } };
    }

    await tx.invoice.update({ where: { id }, data });

    await writeAudit(tx, {
      action: 'invoice.updated',
      entityType: 'Invoice',
      entityId: id,
      severity: 'INFO',
      summary: `${actor.email} edited draft invoice ${invoice.referenceNumber}`,
      organizationId: invoice.organizationId,
      vendorId: invoice.vendorId,
      actor: auditActorOf(actor, ctx),
      after: { fields: Object.keys(input) },
    });
  });

  return loadInvoice(actor, id);
}

/* -------------------------------------------------------------------------- */
/* The match                                                                  */
/* -------------------------------------------------------------------------- */

/** Assemble the engine's input from stored rows. Pure engine, impure gatherer. */
async function buildMatchInput(
  client: Prisma.TransactionClient,
  invoice: InvoiceWithRelations,
  options: { countThisInvoice: boolean },
): Promise<MatchInput> {
  const po = await client.purchaseOrder.findUniqueOrThrow({
    where: { id: invoice.purchaseOrderId },
    include: { items: true },
  });
  const organization = await client.organization.findUniqueOrThrow({
    where: { id: invoice.organizationId },
  });
  const settings = getSettings(organization);

  const duplicates = await client.invoice.count({
    where: {
      vendorId: invoice.vendorId,
      vendorInvoiceNumber: invoice.vendorInvoiceNumber,
      id: { not: invoice.id },
    },
  });

  const grnCount = await client.grn.count({ where: { purchaseOrderId: invoice.purchaseOrderId } });

  return {
    invoice: {
      vendorId: invoice.vendorId,
      totalAmount: invoice.totalAmount,
      freightAmount: invoice.freightAmount,
      items: invoice.items.map((item) => ({
        srNo: item.purchaseOrderItem?.srNo ?? 0,
        purchaseOrderItemId: item.purchaseOrderItemId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPercent: '0.00',
        taxRatePercent: item.taxRatePercent,
        taxableValue: item.taxableValue,
        cgstAmount: item.cgstAmount,
        sgstAmount: item.sgstAmount,
        igstAmount: item.igstAmount,
        // On a rematch this invoice's quantity is already in `invoicedQuantity`,
        // so it is added back or the invoice fails against itself.
        previouslyInvoiced: options.countThisInvoice ? item.quantity : 0,
      })),
    },
    po: {
      status: po.status,
      vendorId: po.vendorId,
      taxRegime: po.taxRegime,
      items: po.items.map((item) => ({
        id: item.id,
        srNo: item.srNo,
        unitPrice: item.unitPrice,
        taxRatePercent: item.taxRatePercent,
        acceptedQuantity: item.acceptedQuantity,
        invoicedQuantity: item.invoicedQuantity,
      })),
    },
    tolerancePercent: settings.matchTolerancePercent,
    duplicateExists: duplicates > 0,
    requireGrn: settings.requireGrnBeforeInvoice,
    grnCount,
  };
}

const persistMatch = (
  tx: Prisma.TransactionClient,
  invoiceId: string,
  result: ReturnType<typeof runMatch>,
) =>
  tx.invoice.update({
    where: { id: invoiceId },
    data: {
      matchStatus: result.status,
      matchResult: result.checks as unknown as Prisma.InputJsonValue,
      matchRunAt: new Date(),
    },
  });

/* -------------------------------------------------------------------------- */
/* Submit (plan 12 §5)                                                        */
/* -------------------------------------------------------------------------- */

export async function submitInvoice(actor: Actor, id: string, ctx: RefreshContext) {
  const loaded = await loadInvoice(actor, id);
  const auditActor = auditActorOf(actor, ctx);

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: loaded.organizationId },
  });
  const settings = getSettings(organization);

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`;

    const invoice = (await tx.invoice.findUniqueOrThrow({
      where: { id },
      include: withRelations,
    })) as InvoiceWithRelations;

    // Guard 1 — DRAFT, or REJECTED being corrected and resubmitted.
    if (invoice.status !== 'DRAFT' && invoice.status !== 'REJECTED') {
      throw BusinessRule(
        'invoice.invalid_transition',
        `A ${invoice.status} invoice cannot be submitted`,
      );
    }

    // Guard 2.
    if (invoice.purchaseOrder.status !== 'ACCEPTED') {
      throw BusinessRule(
        'invoice.po_not_accepted',
        `The purchase order is ${invoice.purchaseOrder.status} and cannot be invoiced`,
      );
    }

    // Guard 3.
    const billed = invoice.items.filter((item) => money(item.quantity).greaterThan(0));
    if (billed.length === 0) {
      throw BusinessRule('invoice.no_items', 'An invoice needs at least one line with a quantity');
    }

    // Guard 4.
    await assertNumberUnused(tx, invoice.vendorId, invoice.vendorInvoiceNumber, invoice.id);

    // Guard 5.
    assertInvoiceDate(invoice.invoiceDate, invoice.purchaseOrder);

    /*
     * Guard 6 — refused before the match rather than as an exception, because an
     * organization that requires goods receipt before invoicing does not want a
     * reviewable exception, it wants the invoice to wait.
     */
    if (settings.requireGrnBeforeInvoice) {
      const grnCount = await tx.grn.count({
        where: { purchaseOrderId: invoice.purchaseOrderId },
      });
      if (grnCount === 0) {
        throw BusinessRule(
          'invoice.grn_required',
          'No goods have been receipted against this order yet',
        );
      }
    }

    const submittedAt = new Date();
    const wasRejected = invoice.status === 'REJECTED';

    await transitionInvoice(tx, invoice, 'SUBMITTED', auditActor, {
      action: wasRejected ? 'invoice.resubmitted' : 'invoice.submitted',
      summary: `${invoice.vendorInvoiceNumber} submitted against ${invoice.purchaseOrder.poNumber} for ${toApi(invoice.totalAmount)}`,
      data: {
        submittedAt,
        dueDate: addDays(invoice.invoiceDate, settings.defaultPaymentTermDays),
        // A resubmission starts clean: the old rejection is history, not state.
        rejectionReason: null,
      },
      after: { totalAmount: toApi(invoice.totalAmount), resubmission: wasRejected },
    });

    // The quantity is claimed now, so the match sees it and so does the next
    // invoice against the same line.
    for (const item of invoice.items) {
      await tx.purchaseOrderItem.update({
        where: { id: item.purchaseOrderItemId },
        data: { invoicedQuantity: { increment: item.quantity } },
      });
    }

    const refreshed = (await tx.invoice.findUniqueOrThrow({
      where: { id },
      include: withRelations,
    })) as InvoiceWithRelations;

    const result = runMatch(await buildMatchInput(tx, refreshed, { countThisInvoice: true }));
    await persistMatch(tx, id, result);

    const submitted = await tx.invoice.findUniqueOrThrow({ where: { id } });
    await transitionInvoice(tx, submitted, 'UNDER_REVIEW', auditActor, {
      action: 'invoice.under_review',
      severity: result.status === 'EXCEPTION' ? 'NOTABLE' : 'INFO',
      summary: `Three-way match on ${invoice.referenceNumber}: ${result.status}`,
      after: {
        matchStatus: result.status,
        failures: result.checks.filter((c) => c.status === 'FAIL').map((c) => c.code),
      },
    });

    /* ----------------------------------------------------------- notifications */

    const officers = await tx.user.findMany({
      where: {
        organizationId: invoice.organizationId,
        status: 'ACTIVE',
        role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] },
      },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      officers.map((u) => u.id),
      {
        type: 'INVOICE_SUBMITTED',
        title: `Invoice ${invoice.vendorInvoiceNumber} received`,
        body: `${invoice.purchaseOrder.vendorName} submitted ${invoice.vendorInvoiceNumber} for ${toApi(invoice.totalAmount)} against ${invoice.purchaseOrder.poNumber}.`,
        entityType: 'Invoice',
        entityId: invoice.id,
        link: `/invoices/${invoice.id}`,
      },
    );

    if (result.status === 'EXCEPTION') {
      const failures = result.checks.filter((c) => c.status === 'FAIL');
      await notifyMany(
        tx,
        officers.map((u) => u.id),
        {
          type: 'INVOICE_MATCH_EXCEPTION',
          title: `Match exception on ${invoice.vendorInvoiceNumber}`,
          body: `${failures.length} check(s) failed: ${failures.map((c) => c.label).join('; ')}`,
          entityType: 'Invoice',
          entityId: invoice.id,
          link: `/invoices/${invoice.id}`,
        },
      );
    }

    return { result, officers };
  });

  emailAfterCommit(
    outcome.officers,
    `Invoice ${loaded.vendorInvoiceNumber} received`,
    `Three-way match result: ${outcome.result.status}.`,
  );

  return loadInvoice(actor, id);
}

/**
 * Re-run the match, for when the missing piece arrives later — most often a GRN
 * that was recorded after the invoice was submitted.
 *
 * It re-matches, it does not re-transition: an invoice already under review stays
 * under review, and an officer still decides.
 */
export async function rematchInvoice(actor: Actor, id: string, ctx: RefreshContext) {
  const invoice = await loadInvoice(actor, id);

  if (invoice.status !== 'UNDER_REVIEW') {
    throw BusinessRule(
      'invoice.invalid_transition',
      `Only an invoice UNDER_REVIEW can be rematched; this one is ${invoice.status}`,
    );
  }
  if (invoice.matchStatus === 'OVERRIDDEN') {
    throw BusinessRule(
      'invoice.already_overridden',
      'This invoice has been overridden; rematching would discard that decision',
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const current = (await tx.invoice.findUniqueOrThrow({
      where: { id },
      include: withRelations,
    })) as InvoiceWithRelations;

    const outcome = runMatch(await buildMatchInput(tx, current, { countThisInvoice: true }));
    await persistMatch(tx, id, outcome);

    await writeAudit(tx, {
      action: 'invoice.rematched',
      entityType: 'Invoice',
      entityId: id,
      severity: 'INFO',
      summary: `${actor.email} re-ran the match on ${invoice.referenceNumber}: ${invoice.matchStatus} to ${outcome.status}`,
      organizationId: invoice.organizationId,
      vendorId: invoice.vendorId,
      actor: auditActorOf(actor, ctx),
      before: { matchStatus: invoice.matchStatus },
      after: {
        matchStatus: outcome.status,
        failures: outcome.checks.filter((c) => c.status === 'FAIL').map((c) => c.code),
      },
    });

    return outcome;
  });

  return { invoice: await loadInvoice(actor, id), result };
}

/* -------------------------------------------------------------------------- */
/* Approve, reject, override (plan 12 §7)                                     */
/* -------------------------------------------------------------------------- */

export async function approveInvoice(
  actor: Actor,
  id: string,
  comment: string | undefined,
  ctx: RefreshContext,
) {
  const loaded = await loadInvoice(actor, id);
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: loaded.organizationId },
  });
  const settings = getSettings(organization);
  const auditActor = auditActorOf(actor, ctx);

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`;

    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id } });

    if (invoice.status !== 'UNDER_REVIEW') {
      throw BusinessRule(
        'invoice.invalid_transition',
        `Only an invoice UNDER_REVIEW can be approved; this one is ${invoice.status}`,
      );
    }

    /*
     * An open exception cannot be approved. It must be fixed by the vendor, or
     * overridden by an admin with a written reason that an auditor will read.
     */
    if (invoice.matchStatus !== 'MATCHED' && invoice.matchStatus !== 'OVERRIDDEN') {
      throw BusinessRule(
        'invoice.match_exception',
        `An invoice with match status ${invoice.matchStatus} cannot be approved`,
      );
    }

    /*
     * Above the threshold this does not clear inline: it raises an approval
     * request and waits for a second person through plan 09's engine, exactly
     * like an award.
     */
    if (money(invoice.totalAmount).greaterThanOrEqualTo(settings.approvalThresholdAmount)) {
      const approval = await createApprovalRequest(tx, {
        organizationId: invoice.organizationId,
        entityType: 'INVOICE',
        entityId: invoice.id,
        amount: invoice.totalAmount,
        requestedById: actor.userId,
        requestNote: comment ?? `Approval of invoice ${invoice.referenceNumber}`,
      });

      await writeAudit(tx, {
        action: 'invoice.approval_requested',
        entityType: 'Invoice',
        entityId: invoice.id,
        severity: 'NOTABLE',
        summary: `${actor.email} raised approval ${approval.id} for ${invoice.referenceNumber} (${toApi(invoice.totalAmount)}), at or above the threshold`,
        organizationId: invoice.organizationId,
        vendorId: invoice.vendorId,
        actor: auditActor,
        after: { approvalId: approval.id, amount: toApi(invoice.totalAmount) },
      });

      const admins = await tx.user.findMany({
        where: {
          organizationId: invoice.organizationId,
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
          title: 'Invoice approval needed',
          body: `${invoice.referenceNumber} for ${toApi(invoice.totalAmount)} is at or above the approval threshold.`,
          entityType: 'Approval',
          entityId: approval.id,
          link: `/approvals/${approval.id}`,
        },
      );

      return { escalated: true as const, recipients: admins };
    }

    await applyInvoiceApproval(tx, invoice.id, actor.userId, comment ?? null, auditActor);

    const vendorUsers = await tx.user.findMany({
      where: { vendorId: invoice.vendorId, status: 'ACTIVE' },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      vendorUsers.map((u) => u.id),
      {
        type: 'INVOICE_APPROVED',
        title: `Invoice ${invoice.vendorInvoiceNumber} approved`,
        body: `${invoice.vendorInvoiceNumber} for ${toApi(invoice.totalAmount)} is approved for payment, due ${invoice.dueDate.toISOString().slice(0, 10)}.`,
        entityType: 'Invoice',
        entityId: invoice.id,
        link: `/vendor/invoices/${invoice.id}`,
      },
    );

    return { escalated: false as const, recipients: vendorUsers };
  });

  emailAfterCommit(
    outcome.recipients,
    outcome.escalated
      ? `Invoice approval needed: ${loaded.referenceNumber}`
      : `Invoice ${loaded.vendorInvoiceNumber} approved`,
    outcome.escalated
      ? 'An invoice at or above the approval threshold is waiting for a decision.'
      : 'Your invoice has been approved for payment.',
  );

  return loadInvoice(actor, id);
}

/**
 * The approval side effect, shared by the inline path and plan 09's approval
 * engine. Exported so `approval.service` can reuse it without duplicating the
 * transition or the audit shape.
 */
export async function applyInvoiceApproval(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  approvedById: string | null,
  comment: string | null,
  actor: AuditActor,
): Promise<Invoice> {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

  return transitionInvoice(tx, invoice, 'APPROVED_FOR_PAYMENT', actor, {
    action: 'invoice.approved',
    severity: 'NOTABLE',
    summary: `${actor.email ?? 'system'} approved ${invoice.referenceNumber} for payment (${toApi(invoice.totalAmount)})${comment ? `: ${comment}` : ''}`,
    data: { approvedById, approvedAt: new Date() },
    after: { amount: toApi(invoice.totalAmount), ...(comment ? { comment } : {}) },
  });
}

/**
 * Reject an invoice back to the vendor.
 *
 * The claimed quantity is released, so the line becomes invoiceable again and the
 * vendor can resubmit a corrected document against it. Without that release the
 * quantity would be stranded and nobody could ever bill for those goods.
 */
export async function rejectInvoice(actor: Actor, id: string, reason: string, ctx: RefreshContext) {
  const loaded = await loadInvoice(actor, id);
  const auditActor = auditActorOf(actor, ctx);

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`;
    return applyInvoiceRejection(tx, id, reason, auditActor);
  });

  emailAfterCommit(
    outcome.vendorUsers,
    `Invoice ${loaded.vendorInvoiceNumber} rejected`,
    `Reason: ${reason}`,
  );

  return loadInvoice(actor, id);
}

/** Shared by the inline path and plan 09's approval engine. */
export async function applyInvoiceRejection(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  reason: string,
  actor: AuditActor,
) {
  const invoice = (await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: withRelations,
  })) as InvoiceWithRelations;

  if (!['SUBMITTED', 'UNDER_REVIEW', 'APPROVED_FOR_PAYMENT'].includes(invoice.status)) {
    throw BusinessRule(
      'invoice.invalid_transition',
      `A ${invoice.status} invoice cannot be rejected`,
    );
  }

  await transitionInvoice(tx, invoice, 'REJECTED', actor, {
    action: 'invoice.rejected',
    severity: 'NOTABLE',
    summary: `${actor.email ?? 'system'} rejected ${invoice.referenceNumber}: ${reason}`,
    data: { rejectionReason: reason },
    reason,
    after: {
      amount: toApi(invoice.totalAmount),
      matchStatus: invoice.matchStatus,
    },
  });

  // Release the quantity so the line can be invoiced again.
  for (const item of invoice.items) {
    await tx.purchaseOrderItem.update({
      where: { id: item.purchaseOrderItemId },
      data: { invoicedQuantity: { decrement: item.quantity } },
    });
  }

  const vendorUsers = await tx.user.findMany({
    where: { vendorId: invoice.vendorId, status: 'ACTIVE' },
    select: { id: true, email: true },
  });

  // The full checklist goes with it: a vendor told only "rejected" cannot fix it.
  const checks = Array.isArray(invoice.matchResult)
    ? (invoice.matchResult as unknown as MatchCheck[])
    : [];
  const failures = checks.filter((check) => check.status === 'FAIL');

  await notifyMany(
    tx,
    vendorUsers.map((u) => u.id),
    {
      type: 'INVOICE_REJECTED',
      title: `Invoice ${invoice.vendorInvoiceNumber} rejected`,
      body: `${reason}${failures.length > 0 ? ` Failed checks: ${failures.map((c) => c.label).join('; ')}` : ''}`,
      entityType: 'Invoice',
      entityId: invoice.id,
      link: `/vendor/invoices/${invoice.id}`,
    },
  );

  return { invoice, vendorUsers };
}

/**
 * Override a match exception.
 *
 * Legitimate and necessary — a ₹40 price difference on an ₹8 lakh order should
 * not stall a payment for a week — but **every override is attributable**: admin
 * only, written reason, SECURITY audit row, and the invoice stays on the
 * exception report permanently.
 *
 * **A quantity exception can never be overridden.** Price and rounding, yes.
 * Claiming goods that were never received, no — that is the one thing this whole
 * module exists to prevent.
 */
export async function overrideMatch(actor: Actor, id: string, reason: string, ctx: RefreshContext) {
  const invoice = await loadInvoice(actor, id);

  if (invoice.matchStatus !== 'EXCEPTION') {
    throw BusinessRule(
      'invoice.nothing_to_override',
      `There is no exception to override; match status is ${invoice.matchStatus}`,
    );
  }

  const checks = Array.isArray(invoice.matchResult)
    ? (invoice.matchResult as unknown as MatchCheck[])
    : [];

  const blocker = hasNonOverridableFailure(checks);
  if (blocker) {
    throw BusinessRule(
      'invoice.quantity_not_overridable',
      `"${blocker.label}" cannot be overridden — goods that were not received cannot be invoiced`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id },
      data: {
        matchStatus: 'OVERRIDDEN',
        overriddenById: actor.userId,
        overrideReason: reason,
      },
    });

    await writeAudit(tx, {
      action: 'invoice.match_overridden',
      entityType: 'Invoice',
      entityId: id,
      // SECURITY: this is what the auditor greps for.
      severity: 'SECURITY',
      summary: `${actor.email} overrode match exceptions on ${invoice.referenceNumber} (${toApi(invoice.totalAmount)}): ${reason}`,
      organizationId: invoice.organizationId,
      vendorId: invoice.vendorId,
      actor: auditActorOf(actor, ctx),
      before: { matchStatus: 'EXCEPTION' },
      after: {
        matchStatus: 'OVERRIDDEN',
        reason,
        amount: toApi(invoice.totalAmount),
        overriddenChecks: checks.filter((c) => c.status === 'FAIL').map((c) => c.code),
      },
    });
  });

  return loadInvoice(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Plan 09 approval seam                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Teach plan 09's approval engine what an invoice decision does.
 *
 * Above-threshold invoices do not clear inline: `approveInvoice` raises an
 * `Approval` and a second admin decides it through the same engine that decides
 * tender awards. This is the other half of that — the engine calls back here so
 * the transition, the quantity release and the vendor notification stay with the
 * invoice rules rather than leaking into the approval module.
 */
export function installInvoiceDecisionHook(): void {
  registerInvoiceDecisionHook(async (tx, context) => {
    if (context.decision === 'APPROVED') {
      await applyInvoiceApproval(
        tx,
        context.invoiceId,
        context.decidedById,
        context.comment,
        context.actor,
      );
      return;
    }

    await applyInvoiceRejection(
      tx,
      context.invoiceId,
      context.comment ?? 'Rejected at approval',
      context.actor,
    );
  });
}
