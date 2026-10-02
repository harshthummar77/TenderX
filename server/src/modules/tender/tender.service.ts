import type { Prisma } from '@prisma/client';
import type { CreateTenderInput, TenderQuery, UpdateTenderInput } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { nextNumber } from '../../lib/numbering.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import { getSettings } from '../organization/organization.service.js';
import { closeBidding, closeExpired } from './deadline.service.js';
import { assertEditable, transitionTender } from './tender.stateMachine.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

const withRelations = {
  items: { orderBy: { srNo: 'asc' } },
  category: true,
  organization: true,
} as const;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function loadTender(actor: Actor, id: string) {
  const tender = await prisma.tender.findFirst({
    where: { id, ...scopeToOrg(actor) },
    include: withRelations,
  });
  if (!tender) throw NotFound('Tender');
  return tender;
}

export async function countsFor(tenderId: string) {
  const [invitations, viewed, quotations] = await Promise.all([
    prisma.tenderInvitation.count({ where: { tenderId } }),
    prisma.tenderInvitation.count({ where: { tenderId, viewedAt: { not: null } } }),
    prisma.quotation.count({ where: { tenderId, status: { not: 'DRAFT' } } }),
  ]);
  return { invitations, viewed, quotations };
}

export async function listTenders(actor: Actor, query: TenderQuery) {
  // Lazy close first: anyone who opens the list closes whatever expired.
  await closeExpired(actor.organizationId ?? undefined);

  const where: Prisma.TenderWhereInput = {
    ...scopeToOrg(actor),
    ...(query.status ? { status: query.status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: 'insensitive' } },
            { referenceNumber: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.tender.findMany({
      where,
      include: withRelations,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.tender.count({ where }),
  ]);

  return { rows, total, page: query.page, limit: query.limit };
}

/* -------------------------------------------------------------------------- */
/* Draft lifecycle                                                            */
/* -------------------------------------------------------------------------- */

const itemData = (items: CreateTenderInput['items']) =>
  items.map((item) => ({
    srNo: item.srNo,
    description: item.description,
    specifications: item.specifications ?? null,
    hsnCode: item.hsnCode ?? null,
    unit: item.unit,
    quantity: item.quantity,
    taxRatePercent: item.taxRatePercent,
    estimatedUnitPrice: item.estimatedUnitPrice ?? null,
  }));

/**
 * A draft carries no reference number. Numbers are reserved at publish, so
 * abandoned drafts never consume one and the sequence stays gapless.
 */
export async function createTender(actor: Actor, input: CreateTenderInput, ctx: RefreshContext) {
  if (!actor.organizationId) throw NotFound('Organization');

  return prisma.$transaction(async (tx) => {
    const tender = await tx.tender.create({
      data: {
        organizationId: actor.organizationId!,
        referenceNumber: '',
        title: input.title,
        description: input.description,
        categoryId: input.categoryId ?? null,
        estimatedBudget: input.estimatedBudget ?? null,
        deliveryLocation: input.deliveryLocation,
        deliveryStateCode: input.deliveryStateCode,
        deliveryDeadline: new Date(input.deliveryDeadline),
        bidSubmissionDeadline: new Date(input.bidSubmissionDeadline),
        evaluationMethod: input.evaluationMethod,
        criteria: (input.criteria ?? []) as unknown as Prisma.InputJsonValue,
        termsAndConditions: input.termsAndConditions ?? null,
        createdById: actor.userId,
        items: { create: itemData(input.items) },
      },
      include: withRelations,
    });

    await writeAudit(tx, {
      action: 'tender.created',
      entityType: 'Tender',
      entityId: tender.id,
      summary: `${actor.email} drafted "${tender.title}" with ${input.items.length} item(s)`,
      organizationId: tender.organizationId,
      actor: auditActorOf(actor, ctx),
      after: { title: tender.title, items: input.items.length },
    });

    return tender;
  });
}

/** Items are replaced wholesale — simpler than diffing, and correct for a draft. */
export async function updateTender(
  actor: Actor,
  id: string,
  input: UpdateTenderInput,
  ctx: RefreshContext,
) {
  const tender = await loadTender(actor, id);
  assertEditable(tender);

  const { items, ...fields } = input as UpdateTenderInput & { items?: CreateTenderInput['items'] };

  return prisma.$transaction(async (tx) => {
    if (items) {
      await tx.tenderItem.deleteMany({ where: { tenderId: id } });
    }

    const updated = await tx.tender.update({
      where: { id },
      data: {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
        ...(fields.categoryId !== undefined ? { categoryId: fields.categoryId } : {}),
        ...(fields.estimatedBudget !== undefined ? { estimatedBudget: fields.estimatedBudget } : {}),
        ...(fields.deliveryLocation !== undefined ? { deliveryLocation: fields.deliveryLocation } : {}),
        ...(fields.deliveryStateCode !== undefined ? { deliveryStateCode: fields.deliveryStateCode } : {}),
        ...(fields.deliveryDeadline ? { deliveryDeadline: new Date(fields.deliveryDeadline) } : {}),
        ...(fields.bidSubmissionDeadline
          ? { bidSubmissionDeadline: new Date(fields.bidSubmissionDeadline) }
          : {}),
        ...(fields.evaluationMethod ? { evaluationMethod: fields.evaluationMethod } : {}),
        ...(fields.criteria ? { criteria: fields.criteria as unknown as Prisma.InputJsonValue } : {}),
        ...(fields.termsAndConditions !== undefined
          ? { termsAndConditions: fields.termsAndConditions }
          : {}),
        ...(items ? { items: { create: itemData(items) } } : {}),
      },
      include: withRelations,
    });

    await writeAudit(tx, {
      action: 'tender.updated',
      entityType: 'Tender',
      entityId: id,
      summary: `${actor.email} edited draft "${updated.title}"`,
      organizationId: updated.organizationId,
      actor: auditActorOf(actor, ctx),
      after: { fields: Object.keys(input) },
    });

    return updated;
  });
}

/**
 * The one hard delete in the system, and it is safe: an unpublished draft has no
 * counterparties, no documents and no history worth keeping. Everything else
 * uses CANCELLED.
 */
export async function deleteDraft(actor: Actor, id: string, ctx: RefreshContext) {
  const tender = await loadTender(actor, id);
  assertEditable(tender);

  await prisma.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: 'tender.draft_deleted',
      entityType: 'Tender',
      entityId: id,
      summary: `${actor.email} deleted draft "${tender.title}"`,
      organizationId: tender.organizationId,
      actor: auditActorOf(actor, ctx),
      before: { title: tender.title, status: tender.status },
    });
    await tx.tender.delete({ where: { id } });
  });
}

/* -------------------------------------------------------------------------- */
/* Publish                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Nine steps, one transaction (07 §4). Step 4 is a real procurement control:
 * single-source quotes are how procurement fraud happens, so the minimum vendor
 * count is enforced — and it is configurable per organization, because three is
 * a policy, not a law of nature.
 */
export async function publishTender(actor: Actor, id: string, ctx: RefreshContext) {
  const tender = await loadTender(actor, id);
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: tender.organizationId },
  });
  const settings = getSettings(organization);

  if (tender.items.length === 0) {
    throw BusinessRule('tender.no_items', 'A tender needs at least one line item before publishing');
  }
  if (tender.bidSubmissionDeadline.getTime() <= Date.now()) {
    throw BusinessRule('tender.deadline_passed', 'The bid submission deadline has already passed');
  }

  const invitations = await prisma.tenderInvitation.findMany({
    where: { tenderId: id },
    include: { vendor: { select: { id: true, status: true, companyName: true } } },
  });

  const approved = invitations.filter((inv) => inv.vendor.status === 'APPROVED');
  if (approved.length < settings.minVendorsPerTender) {
    throw BusinessRule(
      'tender.insufficient_vendors',
      `At least ${settings.minVendorsPerTender} approved vendors must be invited (currently ${approved.length})`,
    );
  }

  if (tender.evaluationMethod === 'WEIGHTED_SCORE') {
    const criteria = Array.isArray(tender.criteria) ? (tender.criteria as { weight: number }[]) : [];
    const total = criteria.reduce((sum, c) => sum + (c.weight ?? 0), 0);
    if (criteria.length === 0 || total !== 100) {
      throw BusinessRule(
        'tender.invalid_criteria',
        `Weighted scoring needs criteria whose weights sum to 100 (currently ${total})`,
      );
    }
  }

  const vendorUsers = await prisma.user.findMany({
    where: { vendorId: { in: approved.map((inv) => inv.vendorId) }, status: 'ACTIVE' },
    select: { id: true, email: true },
  });

  const published = await prisma.$transaction(async (tx) => {
    // Reserved inside the transaction: a rollback must not burn the number.
    const referenceNumber = await nextNumber(tx, tender.organizationId, 'TENDER', {
      prefix: settings.numberPrefixes.TENDER,
    });

    const published = await transitionTender(tx, tender, 'PUBLISHED', auditActorOf(actor, ctx), {
      action: 'tender.published',
      summary: `${actor.email} published ${referenceNumber} to ${approved.length} vendor(s)`,
      data: { referenceNumber, publishedAt: new Date() },
    });

    await notifyMany(
      tx,
      vendorUsers.map((u) => u.id),
      {
        type: 'TENDER_INVITED',
        title: 'You have been invited to bid',
        body: `${organization.name} published "${tender.title}". Bids close ${tender.bidSubmissionDeadline.toISOString()}.`,
        entityType: 'Tender',
        entityId: tender.id,
        link: `/vendor/tenders/${tender.id}`,
      },
    );

    return published;
  });

  emailAfterCommit(
    vendorUsers,
    `Invitation to bid: ${tender.title}`,
    `${organization.name} has invited you to submit a quotation.`,
  );

  return loadTender(actor, published.id);
}

export async function cancelTender(actor: Actor, id: string, reason: string, ctx: RefreshContext) {
  const tender = await loadTender(actor, id);

  const vendorUsers = await prisma.user.findMany({
    where: {
      vendorId: { in: (await prisma.tenderInvitation.findMany({ where: { tenderId: id }, select: { vendorId: true } })).map((i) => i.vendorId) },
      status: 'ACTIVE',
    },
    select: { id: true, email: true },
  });

  await prisma.$transaction(async (tx) => {
    await transitionTender(tx, tender, 'CANCELLED', auditActorOf(actor, ctx), {
      action: 'tender.cancelled',
      summary: `${actor.email} cancelled ${tender.referenceNumber ?? tender.title}: ${reason}`,
      severity: 'SECURITY',
      data: { cancelledAt: new Date(), cancellationReason: reason },
      reason,
    });

    await notifyMany(
      tx,
      vendorUsers.map((u) => u.id),
      {
        type: 'TENDER_CANCELLED',
        title: 'Tender cancelled',
        body: `${tender.title} was cancelled: ${reason}`,
        entityType: 'Tender',
        entityId: id,
        link: `/vendor/tenders/${id}`,
      },
    );
  });

  emailAfterCommit(vendorUsers, `Tender cancelled: ${tender.title}`, reason);
  return loadTender(actor, id);
}

/** Manual early close — the officer decides not to wait for the deadline. */
export async function closeBiddingEarly(actor: Actor, id: string, ctx: RefreshContext) {
  const tender = await loadTender(actor, id);
  if (tender.status !== 'PUBLISHED') {
    throw BusinessRule(
      'tender.invalid_transition',
      `Cannot close bidding on a ${tender.status} tender`,
    );
  }

  await closeBidding(id, auditActorOf(actor, ctx));
  return loadTender(actor, id);
}

/**
 * `bidSummary` moved to the quotation module (plan 08 §3): it reads bids, so it
 * belongs with the code that owns the seal.
 */
