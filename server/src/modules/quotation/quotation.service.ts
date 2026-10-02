import type { Prisma, QuotationItem, Tender, TenderItem } from '@prisma/client';
import type { BidSummary, QuotationDraftInput, QuotationQuery } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { gt, money } from '../../lib/money.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { nextNumber } from '../../lib/numbering.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import { getSettings } from '../organization/organization.service.js';
import { loadTender } from '../tender/tender.service.js';
import { recomputeTotals, type PricingLineInput } from './pricing.js';
import {
  sealedBuyerSelect,
  toQuotationBuyerDto,
  toSealedQuotationDto,
  type QuotationWithRelations,
  type SealedBuyerRow,
} from './quotation.serializers.js';
import { assertQuotationEditable, transitionQuotation } from './quotation.stateMachine.js';
import { computeSealHash, isSealed, verifySeal } from './sealing.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

const withRelations = {
  items: { include: { tenderItem: true }, orderBy: { tenderItem: { srNo: 'asc' } } },
  vendor: true,
  tender: true,
} as const;

/**
 * The clock that matters.
 *
 * Every deadline comparison in this module reads `now()` from Postgres, never
 * `Date.now()`. A vendor's browser clock is theirs to set, and even the API
 * server's clock can drift from the database's — but the deadline and the
 * submission timestamp must be measured against the same clock, or "did this
 * bid arrive in time?" has two answers.
 */
async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  if (!row) throw new Error('Could not read the database clock');
  return row.now;
}

/* -------------------------------------------------------------------------- */
/* Vendor side                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A quotation is reached through its vendor, always. There is no code path in
 * this module that loads a bid by id alone (04 §1) — another vendor's bid is a
 * 404, exactly like any other cross-tenant read.
 */
export async function loadOwnQuotation(actor: Actor, id: string) {
  if (!actor.vendorId) throw NotFound('Quotation');

  const quotation = await prisma.quotation.findFirst({
    where: { id, vendorId: actor.vendorId },
    include: withRelations,
  });
  if (!quotation) throw NotFound('Quotation');
  return quotation as QuotationWithRelations & { tender: Tender };
}

export async function listOwnQuotations(actor: Actor, query: QuotationQuery) {
  if (!actor.vendorId) throw NotFound('Vendor');

  const where: Prisma.QuotationWhereInput = {
    vendorId: actor.vendorId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.tenderId ? { tenderId: query.tenderId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.quotation.findMany({
      where,
      include: withRelations,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.quotation.count({ where }),
  ]);

  return { rows: rows as (QuotationWithRelations & { tender: Tender })[], total, page: query.page, limit: query.limit };
}

/** The tender a vendor may bid on: published, still open, and one they were invited to. */
async function loadBiddableTender(vendorId: string, tenderId: string) {
  const tender = await prisma.tender.findFirst({
    where: { id: tenderId, invitations: { some: { vendorId } } },
    include: { items: { orderBy: { srNo: 'asc' } } },
  });
  if (!tender) throw NotFound('Tender');

  if (tender.status !== 'PUBLISHED') {
    throw BusinessRule('quotation.tender_not_open', `This tender is ${tender.status} and is not accepting bids`);
  }
  if (tender.bidSubmissionDeadline.getTime() <= Date.now()) {
    throw BusinessRule('quotation.deadline_passed', 'The bid submission deadline has passed');
  }
  return tender;
}

/**
 * Create the draft, or hand back the one already in progress.
 *
 * Idempotent on purpose: the vendor's "Bid now" button is the entry point to the
 * pricing screen and they will press it again tomorrow. The draft is seeded with
 * one line per tender line at the tender's quantity and a zero price, so the
 * "every item priced" guard at submit is about *prices*, not about missing rows.
 */
export async function openDraft(actor: Actor, tenderId: string, ctx: RefreshContext) {
  if (!actor.vendorId) throw NotFound('Vendor');
  const vendorId = actor.vendorId;

  const tender = await loadBiddableTender(vendorId, tenderId);

  const existing = await prisma.quotation.findFirst({
    where: { tenderId, vendorId, isLatest: true },
    include: withRelations,
  });

  if (existing) {
    if (existing.status === 'DRAFT') return existing as QuotationWithRelations & { tender: Tender };
    if (existing.status === 'SUBMITTED') {
      throw BusinessRule(
        'quotation.already_submitted',
        'You have already submitted a bid for this tender. Revise it instead.',
      );
    }
    throw BusinessRule(
      'quotation.invalid_transition',
      `Your bid for this tender is ${existing.status} and cannot be reopened`,
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const draft = await tx.quotation.create({
      data: {
        tenderId,
        vendorId,
        // Numbers are reserved at submission, exactly as a tender reserves its
        // number at publish: an abandoned draft must not consume one.
        referenceNumber: '',
        items: {
          create: tender.items.map((item) => ({
            tenderItemId: item.id,
            quantity: item.quantity,
            unitPrice: 0,
            discountPercent: 0,
            taxableValue: 0,
            taxRatePercent: item.taxRatePercent,
            taxAmount: 0,
            lineTotal: 0,
          })),
        },
      },
      include: withRelations,
    });

    await writeAudit(tx, {
      action: 'quotation.draft_created',
      entityType: 'Quotation',
      entityId: draft.id,
      summary: `${actor.email} started a bid on ${tender.referenceNumber || tender.title}`,
      organizationId: tender.organizationId,
      vendorId,
      actor: auditActorOf(actor, ctx),
      after: { tenderId, items: tender.items.length },
    });

    return draft;
  });

  return created as QuotationWithRelations & { tender: Tender };
}

/**
 * Autosave.
 *
 * **The client may send totals for display; the server ignores them.** Nothing
 * here reads a total off the request — `quotationDraftSchema` does not even
 * accept one, and every figure is recomputed from quantity, unit price,
 * discount and the *tender's* tax rate. A vendor who posts `grandTotal: "1.00"`
 * gets a 422 for the unknown key, and if that guard ever moved they would still
 * get the correct total stored.
 */
export async function updateDraft(
  actor: Actor,
  id: string,
  input: QuotationDraftInput,
  ctx: RefreshContext,
) {
  const quotation = await loadOwnQuotation(actor, id);
  assertQuotationEditable(quotation);

  const tender = await loadBiddableTender(quotation.vendorId, quotation.tenderId);
  const tenderItems = tender.items;

  const lines: PricingLineInput[] = input.items
    ? input.items.map((item) => ({
        tenderItemId: item.tenderItemId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent,
        deliveryDays: item.deliveryDays ?? null,
        brandOrMake: item.brandOrMake ?? null,
        remarks: item.remarks ?? null,
      }))
    : quotation.items.map((item) => ({
        tenderItemId: item.tenderItemId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent,
        deliveryDays: item.deliveryDays,
        brandOrMake: item.brandOrMake,
        remarks: item.remarks,
      }));

  assertLinesMatchTender(lines, tenderItems);

  const priced = recomputeTotals(
    lines,
    tenderItems.map((item) => ({ tenderItemId: item.id, taxRatePercent: item.taxRatePercent })),
    input.freightAmount ?? quotation.freightAmount,
  );

  const updated = await prisma.$transaction(async (tx) => {
    // Items are replaced wholesale — simpler than diffing, and correct for a draft.
    await tx.quotationItem.deleteMany({ where: { quotationId: id } });

    const row = await tx.quotation.update({
      where: { id },
      data: {
        ...(input.deliveryDays !== undefined ? { deliveryDays: input.deliveryDays } : {}),
        ...(input.validityDays !== undefined ? { validityDays: input.validityDays } : {}),
        ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        subtotal: priced.subtotal.toFixed(2),
        discountAmount: priced.discountAmount.toFixed(2),
        taxableAmount: priced.taxableAmount.toFixed(2),
        taxAmount: priced.taxAmount.toFixed(2),
        freightAmount: priced.freightAmount.toFixed(2),
        grandTotal: priced.grandTotal.toFixed(2),
        items: { create: priced.lines.map(itemCreateData) },
      },
      include: withRelations,
    });

    // The audit row names the fields that changed and never their values: an
    // audit trail a buyer can read must not become the leak the seal prevents.
    await writeAudit(tx, {
      action: 'quotation.draft_saved',
      entityType: 'Quotation',
      entityId: id,
      severity: 'INFO',
      summary: `${actor.email} saved their draft bid on ${tender.referenceNumber || tender.title}`,
      organizationId: tender.organizationId,
      vendorId: quotation.vendorId,
      actor: auditActorOf(actor, ctx),
      after: { fields: Object.keys(input), lines: priced.lines.length },
    });

    return row;
  });

  return updated as QuotationWithRelations & { tender: Tender };
}

const itemCreateData = (line: ReturnType<typeof recomputeTotals>['lines'][number]) => ({
  tenderItemId: line.tenderItemId,
  quantity: line.quantity.toFixed(3),
  unitPrice: line.unitPrice.toFixed(2),
  discountPercent: line.discountPercent.toFixed(2),
  taxableValue: line.taxableValue.toFixed(2),
  taxRatePercent: line.taxRatePercent.toFixed(2),
  taxAmount: line.taxAmount.toFixed(2),
  lineTotal: line.lineTotal.toFixed(2),
  deliveryDays: line.deliveryDays,
  brandOrMake: line.brandOrMake,
  remarks: line.remarks,
});

/**
 * Every quoted line must belong to this tender, and must quote the full
 * quantity. Partial bids are a tender-level policy this plan does not implement,
 * so a short quantity is refused rather than silently accepted and then
 * compared against full-quantity rivals in plan 09.
 */
function assertLinesMatchTender(lines: PricingLineInput[], tenderItems: TenderItem[]): void {
  const byId = new Map(tenderItems.map((item) => [item.id, item]));

  for (const line of lines) {
    const tenderItem = byId.get(line.tenderItemId);
    if (!tenderItem) {
      throw BusinessRule('quotation.unknown_item', `Line ${line.tenderItemId} is not part of this tender`);
    }
    if (!money(line.quantity).equals(money(tenderItem.quantity))) {
      throw BusinessRule(
        'quotation.quantity_mismatch',
        `Line ${tenderItem.srNo} must be quoted for the full tender quantity`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Submit — the nine guards (08 §5)                                           */
/* -------------------------------------------------------------------------- */

export async function submitQuotation(actor: Actor, id: string, ctx: RefreshContext) {
  // Guard 1: a bid that is not this vendor's is a 404, before anything else.
  const loaded = await loadOwnQuotation(actor, id);
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: loaded.tender.organizationId },
  });
  const settings = getSettings(organization);

  const submitted = await prisma.$transaction(async (tx) => {
    /*
     * Two rapid submits are the same row, not two rows, so the partial unique
     * index cannot separate them. A row lock can: the second transaction blocks
     * here until the first commits, then reads SUBMITTED and is refused. Without
     * it both read DRAFT, both pass, and the second overwrites the first bid's
     * reference number and seal.
     */
    await tx.$queryRaw`SELECT id FROM quotations WHERE id = ${id}::uuid FOR UPDATE`;

    const quotation = await tx.quotation.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });

    // Guard 9 (first half): the specific message beats the generic one.
    if (quotation.status === 'SUBMITTED') {
      throw BusinessRule('quotation.already_submitted', 'This bid has already been submitted');
    }
    // Guard 2.
    if (quotation.status !== 'DRAFT') {
      throw BusinessRule(
        'quotation.invalid_transition',
        `A ${quotation.status} quotation cannot be submitted`,
      );
    }

    const tender = await tx.tender.findUniqueOrThrow({
      where: { id: quotation.tenderId },
      include: { items: true },
    });

    // Guard 3.
    if (tender.status !== 'PUBLISHED') {
      throw BusinessRule(
        'quotation.tender_not_open',
        `This tender is ${tender.status} and is not accepting bids`,
      );
    }

    // Guard 4 — against the database clock, whatever the client believes.
    const now = await dbNow(tx);
    if (now.getTime() >= tender.bidSubmissionDeadline.getTime()) {
      throw BusinessRule('quotation.deadline_passed', 'The bid submission deadline has passed');
    }

    // Guard 5.
    const vendor = await tx.vendor.findUniqueOrThrow({
      where: { id: quotation.vendorId },
      select: { id: true, companyName: true, status: true },
    });
    if (vendor.status !== 'APPROVED') {
      throw BusinessRule(
        'quotation.vendor_not_approved',
        `A ${vendor.status} vendor cannot submit a bid`,
      );
    }

    // Guard 6.
    const invitation = await tx.tenderInvitation.findUnique({
      where: { tenderId_vendorId: { tenderId: tender.id, vendorId: vendor.id } },
      select: { id: true },
    });
    if (!invitation) {
      throw BusinessRule('quotation.not_invited', 'You were not invited to bid on this tender');
    }

    // Guard 7.
    const quotedItemIds = new Set(quotation.items.map((item) => item.tenderItemId));
    const missing = tender.items.filter((item) => !quotedItemIds.has(item.id));
    if (missing.length > 0) {
      throw BusinessRule(
        'quotation.incomplete_items',
        `Every tender line must be priced — ${missing.length} line(s) are missing`,
      );
    }

    // Guard 8.
    const unpriced = quotation.items.filter((item) => !gt(item.unitPrice, 0));
    if (unpriced.length > 0) {
      throw BusinessRule(
        'quotation.invalid_price',
        `Every line needs a unit price above zero — ${unpriced.length} line(s) are not priced`,
      );
    }

    // Guard 9 (second half), backed by the `one_latest_quotation` partial index.
    const live = await tx.quotation.count({
      where: {
        tenderId: tender.id,
        vendorId: vendor.id,
        status: 'SUBMITTED',
        isLatest: true,
        id: { not: id },
      },
    });
    if (live > 0) {
      throw BusinessRule('quotation.already_submitted', 'A live bid already exists for this tender');
    }

    /* ----------------------------------------------------------------------
     * Guards passed. Recompute, number, seal, transition, notify — one unit.
     * -------------------------------------------------------------------- */

    const priced = recomputeTotals(
      quotation.items.map((item) => ({
        tenderItemId: item.tenderItemId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent,
        deliveryDays: item.deliveryDays,
        brandOrMake: item.brandOrMake,
        remarks: item.remarks,
      })),
      tender.items.map((item) => ({ tenderItemId: item.id, taxRatePercent: item.taxRatePercent })),
      quotation.freightAmount,
    );

    await tx.quotationItem.deleteMany({ where: { quotationId: id } });
    await tx.quotationItem.createMany({
      data: priced.lines.map((line) => ({ quotationId: id, ...itemCreateData(line) })),
    });

    // Numbered per *organization*: the quotation register is the buyer's
    // document register, not the vendor's. Reserved inside the transaction so a
    // rollback cannot burn the number.
    const referenceNumber = await nextNumber(tx, tender.organizationId, 'QUOTATION', {
      prefix: settings.numberPrefixes.QUOTATION,
    });

    const sealHash = computeSealHash({
      tenderId: tender.id,
      vendorId: vendor.id,
      submittedAt: now,
      items: priced.lines,
      grandTotal: priced.grandTotal,
    });

    const result = await transitionQuotation(tx, quotation, 'SUBMITTED', auditActorOf(actor, ctx), {
      action: 'quotation.submitted',
      organizationId: tender.organizationId,
      summary: `${vendor.companyName} submitted bid ${referenceNumber} on ${tender.referenceNumber || tender.title}`,
      data: {
        referenceNumber,
        submittedAt: now,
        sealHash,
        subtotal: priced.subtotal.toFixed(2),
        discountAmount: priced.discountAmount.toFixed(2),
        taxableAmount: priced.taxableAmount.toFixed(2),
        taxAmount: priced.taxAmount.toFixed(2),
        freightAmount: priced.freightAmount.toFixed(2),
        grandTotal: priced.grandTotal.toFixed(2),
      },
      // The audit row carries the seal, never the amount: an officer with
      // AUDIT_VIEW must not be able to read a sealed bid out of history.
      after: { referenceNumber, sealHash, itemCount: priced.lines.length },
    });

    const officers = await tx.user.findMany({
      where: {
        organizationId: tender.organizationId,
        status: 'ACTIVE',
        role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] },
      },
      select: { id: true, email: true },
    });

    /*
     * **No amount in this notification, ever** (plan 14 §4). An email that says
     * "Acme bid ₹6,89,000" defeats the entire seal — the officer now knows a
     * number before the deadline, and knowing one bid is enough to leak it to a
     * rival. Vendor name and timestamp are fine: knowing *who* bid is normal in
     * procurement, knowing *how much* is not.
     */
    await notifyMany(
      tx,
      officers.map((o) => o.id),
      {
        type: 'QUOTATION_RECEIVED',
        title: 'Sealed bid received',
        body: `${vendor.companyName} submitted a sealed bid on "${tender.title}". Amounts stay sealed until bidding closes.`,
        entityType: 'Tender',
        entityId: tender.id,
        link: `/tenders/${tender.id}/bid-summary`,
      },
    );

    return { quotation: result, officers, vendor, tender, sealHash };
  });

  emailAfterCommit(
    submitted.officers,
    `Sealed bid received: ${submitted.tender.title}`,
    `${submitted.vendor.companyName} submitted a sealed bid. Amounts stay sealed until bidding closes.`,
  );

  return loadOwnQuotation(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Withdraw (08 §7)                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Allowed only while SUBMITTED **and** before the deadline. After the deadline a
 * bid is binding — that is what a sealed tender means, and a vendor who could
 * pull out after seeing the field could bid recklessly for free.
 */
export async function withdrawQuotation(
  actor: Actor,
  id: string,
  reason: string,
  ctx: RefreshContext,
) {
  const loaded = await loadOwnQuotation(actor, id);

  const withdrawn = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM quotations WHERE id = ${id}::uuid FOR UPDATE`;

    const quotation = await tx.quotation.findUniqueOrThrow({ where: { id } });
    if (quotation.status !== 'SUBMITTED') {
      throw BusinessRule(
        'quotation.invalid_transition',
        `A ${quotation.status} quotation cannot be withdrawn`,
      );
    }

    const tender = await tx.tender.findUniqueOrThrow({ where: { id: quotation.tenderId } });
    const now = await dbNow(tx);
    if (now.getTime() >= tender.bidSubmissionDeadline.getTime()) {
      throw BusinessRule(
        'quotation.deadline_passed',
        'A bid is binding once the submission deadline has passed',
      );
    }

    const result = await transitionQuotation(tx, quotation, 'WITHDRAWN', auditActorOf(actor, ctx), {
      action: 'quotation.withdrawn',
      severity: 'NOTABLE',
      organizationId: tender.organizationId,
      summary: `${loaded.vendor.companyName} withdrew bid ${quotation.referenceNumber || quotation.id}: ${reason}`,
      data: { withdrawnAt: now, withdrawalReason: reason },
      reason,
    });

    const officers = await tx.user.findMany({
      where: {
        organizationId: tender.organizationId,
        status: 'ACTIVE',
        role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] },
      },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      officers.map((o) => o.id),
      {
        type: 'QUOTATION_WITHDRAWN',
        title: 'Bid withdrawn',
        body: `${loaded.vendor.companyName} withdrew their bid on "${tender.title}": ${reason}`,
        entityType: 'Tender',
        entityId: tender.id,
        link: `/tenders/${tender.id}/bid-summary`,
      },
    );

    return { quotation: result, officers, tender };
  });

  emailAfterCommit(
    withdrawn.officers,
    `Bid withdrawn: ${withdrawn.tender.title}`,
    `${loaded.vendor.companyName} withdrew their bid. Reason: ${reason}`,
  );

  return loadOwnQuotation(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Revise (08 §6)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Revising must never destroy the original submission — that would break the
 * audit story. The original keeps its rows, its seal and its timestamp, and only
 * loses `isLatest`; the revision is a fresh DRAFT the vendor re-prices and
 * re-submits.
 *
 * Invariant: **exactly one row per (tenderId, vendorId) has `isLatest = true`**,
 * enforced by the `one_latest_quotation` partial unique index. Evaluation (plan
 * 09) only ever considers `isLatest = true AND status = 'SUBMITTED'`.
 */
export async function reviseQuotation(actor: Actor, id: string, ctx: RefreshContext) {
  const original = await loadOwnQuotation(actor, id);

  if (original.status !== 'SUBMITTED') {
    throw BusinessRule(
      'quotation.invalid_transition',
      `A ${original.status} quotation cannot be revised`,
    );
  }

  const revision = await prisma.$transaction(async (tx) => {
    const tender = await tx.tender.findUniqueOrThrow({ where: { id: original.tenderId } });
    if (tender.status !== 'PUBLISHED') {
      throw BusinessRule(
        'quotation.tender_not_open',
        `This tender is ${tender.status} and is not accepting bids`,
      );
    }

    const now = await dbNow(tx);
    if (now.getTime() >= tender.bidSubmissionDeadline.getTime()) {
      throw BusinessRule('quotation.deadline_passed', 'The bid submission deadline has passed');
    }

    // Order matters: the partial unique index is checked per statement, so the
    // original must stop being latest before the replacement claims it.
    await tx.quotation.update({ where: { id: original.id }, data: { isLatest: false } });

    const created = await tx.quotation.create({
      data: {
        tenderId: original.tenderId,
        vendorId: original.vendorId,
        referenceNumber: '',
        status: 'DRAFT',
        subtotal: original.subtotal,
        discountAmount: original.discountAmount,
        taxableAmount: original.taxableAmount,
        taxAmount: original.taxAmount,
        freightAmount: original.freightAmount,
        grandTotal: original.grandTotal,
        deliveryDays: original.deliveryDays,
        validityDays: original.validityDays,
        paymentTerms: original.paymentTerms,
        notes: original.notes,
        revisionNumber: original.revisionNumber + 1,
        revisionOfId: original.id,
        isLatest: true,
        submittedAt: null,
        sealHash: null,
        items: {
          create: original.items.map((item: QuotationItem) => ({
            tenderItemId: item.tenderItemId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discountPercent: item.discountPercent,
            taxableValue: item.taxableValue,
            taxRatePercent: item.taxRatePercent,
            taxAmount: item.taxAmount,
            lineTotal: item.lineTotal,
            deliveryDays: item.deliveryDays,
            brandOrMake: item.brandOrMake,
            remarks: item.remarks,
          })),
        },
      },
      include: withRelations,
    });

    await writeAudit(tx, {
      action: 'quotation.revised',
      entityType: 'Quotation',
      entityId: created.id,
      severity: 'NOTABLE',
      summary: `${original.vendor.companyName} opened revision ${created.revisionNumber} of bid ${original.referenceNumber || original.id}`,
      organizationId: tender.organizationId,
      vendorId: original.vendorId,
      actor: auditActorOf(actor, ctx),
      before: { quotationId: original.id, revisionNumber: original.revisionNumber },
      after: { quotationId: created.id, revisionNumber: created.revisionNumber },
    });

    return created;
  });

  return revision as QuotationWithRelations & { tender: Tender };
}

/* -------------------------------------------------------------------------- */
/* Buyer side — sealed-aware reads                                            */
/* -------------------------------------------------------------------------- */

/**
 * Layer 2 (08 §1). While the tender is sealed the query itself is restricted:
 * the `select` never names a money column, so the amounts do not leave Postgres.
 * Layer 1 (the serializer) would have dropped them anyway — two layers, because
 * one of them is one edit away from being wrong at any time.
 *
 * Drafts are excluded entirely: a bid that was never submitted is not the
 * buyer's business, sealed or not.
 */
export async function listTenderQuotations(actor: Actor, tenderId: string) {
  const tender = await loadTender(actor, tenderId);
  const where: Prisma.QuotationWhereInput = {
    tenderId,
    isLatest: true,
    status: { not: 'DRAFT' },
  };

  if (isSealed(tender)) {
    const rows = await prisma.quotation.findMany({
      where,
      select: sealedBuyerSelect,
      orderBy: { submittedAt: 'asc' },
    });
    return rows.map((row) => toSealedQuotationDto(row as unknown as SealedBuyerRow));
  }

  const rows = await prisma.quotation.findMany({
    where,
    include: withRelations,
    orderBy: [{ rank: 'asc' }, { grandTotal: 'asc' }],
  });
  return rows.map((row) => toQuotationBuyerDto(row as QuotationWithRelations, tender));
}

export async function getQuotationForBuyer(actor: Actor, id: string) {
  // Scoped through the tender: a quotation has no organizationId of its own.
  const stub = await prisma.quotation.findFirst({
    where: { id, status: { not: 'DRAFT' }, tender: scopeToOrg(actor) },
    select: { id: true, tenderId: true },
  });
  if (!stub) throw NotFound('Quotation');

  const tender = await loadTender(actor, stub.tenderId);

  if (isSealed(tender)) {
    const row = await prisma.quotation.findUniqueOrThrow({
      where: { id },
      select: sealedBuyerSelect,
    });
    return toSealedQuotationDto(row as unknown as SealedBuyerRow);
  }

  const row = await prisma.quotation.findUniqueOrThrow({ where: { id }, include: withRelations });
  return toQuotationBuyerDto(row as QuotationWithRelations, tender);
}

/**
 * What the officer stares at while waiting (08 §3).
 *
 * Vendor names and timestamps are fine before the deadline — knowing *who* bid
 * is normal in procurement. Knowing *how much* is not, so this endpoint returns
 * counts, names, times and seal hashes, and there is no branch in it that can
 * reach an amount.
 */
export async function bidSummary(actor: Actor, tenderId: string): Promise<BidSummary> {
  const tender = await loadTender(actor, tenderId);

  const [invited, viewed, declined, drafts, submissions] = await Promise.all([
    prisma.tenderInvitation.count({ where: { tenderId } }),
    prisma.tenderInvitation.count({ where: { tenderId, viewedAt: { not: null } } }),
    prisma.tenderInvitation.count({ where: { tenderId, declinedReason: { not: null } } }),
    prisma.quotation.count({ where: { tenderId, status: 'DRAFT' } }),
    prisma.quotation.findMany({
      where: { tenderId, isLatest: true, status: { notIn: ['DRAFT', 'WITHDRAWN'] } },
      select: { submittedAt: true, sealHash: true, vendor: { select: { companyName: true } } },
      orderBy: { submittedAt: 'asc' },
    }),
  ]);

  const msRemaining = tender.bidSubmissionDeadline.getTime() - Date.now();

  return {
    invited,
    viewed,
    declined,
    drafts,
    submitted: submissions.length,
    sealed: isSealed(tender),
    bidsOpenAt: (tender.bidOpenedAt ?? tender.bidSubmissionDeadline).toISOString(),
    secondsRemaining: msRemaining <= 0 ? 0 : Math.ceil(msRemaining / 1000),
    submissions: submissions.map((row) => ({
      vendorName: row.vendor.companyName,
      submittedAt: row.submittedAt?.toISOString() ?? '',
      sealHash: row.sealHash,
    })),
  };
}

/**
 * Proof the bid was not altered after submission (08 §1).
 *
 * Only after opening: while sealed, the answer would be a true/false fact about
 * a bid nobody may inspect yet, and an officer who can re-run it after editing
 * a row is exactly the attack this is meant to catch.
 */
export async function verifyQuotationSeal(actor: Actor, id: string) {
  const stub = await prisma.quotation.findFirst({
    where: { id, tender: scopeToOrg(actor) },
    select: { id: true, tenderId: true },
  });
  if (!stub) throw NotFound('Quotation');

  const tender = await loadTender(actor, stub.tenderId);
  if (isSealed(tender)) {
    throw BusinessRule('quotation.still_sealed', 'Seals can only be verified after bidding closes');
  }

  const result = await verifySeal(id);
  return {
    valid: result.valid,
    sealHash: result.sealHash,
    computedHash: result.computedHash,
    submittedAt: result.submittedAt,
  };
}
