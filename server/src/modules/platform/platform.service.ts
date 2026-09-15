import type { Organization, Prisma } from '@prisma/client';
import {
  DOC_SEQUENCE_TYPES,
  fiscalYear,
  isValidGstin,
  orgSettingsSchema,
  type PlatformOrgQuery,
  type PlatformStats,
} from '@tb/shared';
import { verifyAuditChain, writeAudit } from '../../lib/audit.js';
import { AppError, NotFound } from '../../lib/errors.js';
import { toApi } from '../../lib/money.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { prisma } from '../../lib/prisma.js';
import type { Actor } from '../../middleware/authenticate.js';
import { bustOrgCache } from '../../middleware/requireActiveOrg.js';
import type { RefreshContext } from '../auth/token.service.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext) => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

/* -------------------------------------------------------------------------- */
/* Listing                                                                    */
/* -------------------------------------------------------------------------- */

export async function listOrganizations(query: PlatformOrgQuery) {
  const where: Prisma.OrganizationWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { gstin: { contains: query.q, mode: 'insensitive' } },
            { city: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      include: { _count: { select: { users: true, tenders: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.organization.count({ where }),
  ]);

  const certified = new Set(
    (
      await prisma.document.findMany({
        where: { type: 'ORG_GST_CERTIFICATE', organizationId: { in: rows.map((r) => r.id) } },
        select: { organizationId: true },
      })
    ).map((d) => d.organizationId!),
  );

  return { rows, total, certified, page: query.page, limit: query.limit };
}

export async function getOrganization(id: string) {
  const org = await prisma.organization.findUnique({
    where: { id },
    include: { _count: { select: { users: true, tenders: true } } },
  });
  if (!org) throw NotFound('Organization');

  const documents = await prisma.document.findMany({
    where: { organizationId: id },
    select: { id: true, type: true, fileName: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  return { org, documents };
}

/* -------------------------------------------------------------------------- */
/* Approval                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Rule 4. Approval is the moment an organization gains the ability to issue
 * legal documents, so the data those documents depend on must already be there
 * and valid — not "filled in later".
 */
export async function missingKyc(org: Organization): Promise<string[]> {
  const missing: string[] = [];

  if (!org.gstin) missing.push('GSTIN is required');
  else if (!isValidGstin(org.gstin)) missing.push('GSTIN fails checksum validation');

  if (!org.pan) missing.push('PAN is required');

  if (!org.addressLine1 || !org.city || !org.state || !org.pincode) {
    missing.push('Complete registered address is required');
  }
  if (!/^\d{2}$/.test(org.stateCode)) missing.push('Valid GST state code is required');

  const hasCertificate = await prisma.document.count({
    where: { organizationId: org.id, type: 'ORG_GST_CERTIFICATE' },
  });
  if (hasCertificate === 0) missing.push('GST certificate document must be uploaded');

  return missing;
}

/**
 * Seed the six number sequences for the current fiscal year, using the org's
 * configured prefixes.
 *
 * Doing it here means plan 07's `nextNumber()` never hits a cold path on the
 * org's first tender — the row already exists, so the atomic upsert is a plain
 * update under concurrency.
 */
async function seedNumberSequences(tx: Prisma.TransactionClient, org: Organization) {
  const settings = orgSettingsSchema.parse(org.settings ?? {});
  const year = fiscalYear();

  for (const docType of DOC_SEQUENCE_TYPES) {
    await tx.numberSequence.upsert({
      where: {
        organizationId_docType_fiscalYear: { organizationId: org.id, docType, fiscalYear: year },
      },
      create: {
        organizationId: org.id,
        docType,
        fiscalYear: year,
        prefix: settings.numberPrefixes[docType],
      },
      update: {},
    });
  }
}

const orgAdminsOf = (organizationId: string) =>
  prisma.user.findMany({
    where: { organizationId, role: 'ORG_ADMIN', status: 'ACTIVE' },
    select: { id: true, email: true },
  });

export async function approveOrganization(actor: Actor, id: string, ctx: RefreshContext) {
  const org = await prisma.organization.findUnique({ where: { id } });
  if (!org) throw NotFound('Organization');

  if (org.status === 'ACTIVE') {
    throw new AppError(422, 'organization.already_active', 'This organization is already active');
  }

  const missing = await missingKyc(org);
  if (missing.length) {
    throw new AppError(
      422,
      'organization.incomplete_kyc',
      'Approval requires complete KYC',
      missing.map((message) => ({ path: 'organization', message })),
    );
  }

  const admins = await orgAdminsOf(id);

  const approved = await prisma.$transaction(async (tx) => {
    const approved = await tx.organization.update({
      where: { id },
      data: { status: 'ACTIVE', approvedAt: new Date(), approvedById: actor.userId },
    });

    await seedNumberSequences(tx, approved);

    await writeAudit(tx, {
      action: 'organization.approved',
      entityType: 'Organization',
      entityId: id,
      summary: `${actor.email} approved "${org.name}"`,
      severity: 'NOTABLE',
      organizationId: id,
      actor: auditActorOf(actor, ctx),
      before: { status: org.status },
      after: { status: 'ACTIVE' },
    });

    await notifyMany(
      tx,
      admins.map((a) => a.id),
      {
        type: 'VENDOR_APPROVED',
        title: 'Your organization has been approved',
        body: `${org.name} is now active. You can publish tenders and issue purchase orders.`,
        entityType: 'Organization',
        entityId: id,
        link: '/organization',
      },
    );

    return approved;
  });

  bustOrgCache(id);
  emailAfterCommit(
    admins,
    'Your TenderBridge organization is approved',
    `${org.name} is now active. Sign in to publish your first tender.`,
  );

  return approved;
}

/**
 * Rejection leaves the org in PENDING_APPROVAL on purpose: it can fix what was
 * wrong and resubmit without re-registering. The reason travels on the audit
 * row and the notification.
 */
export async function rejectOrganization(
  actor: Actor,
  id: string,
  reason: string,
  ctx: RefreshContext,
) {
  const org = await prisma.organization.findUnique({ where: { id } });
  if (!org) throw NotFound('Organization');

  if (org.status === 'ACTIVE') {
    throw new AppError(
      422,
      'organization.already_active',
      'An active organization cannot be rejected — suspend it instead',
    );
  }

  const admins = await orgAdminsOf(id);

  await prisma.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: 'organization.rejected',
      entityType: 'Organization',
      entityId: id,
      summary: `${actor.email} rejected "${org.name}": ${reason}`,
      severity: 'NOTABLE',
      organizationId: id,
      actor: auditActorOf(actor, ctx),
      before: { status: org.status },
      after: { status: org.status, reason },
    });

    await notifyMany(
      tx,
      admins.map((a) => a.id),
      {
        type: 'VENDOR_REJECTED',
        title: 'Your organization needs attention',
        body: reason,
        entityType: 'Organization',
        entityId: id,
        link: '/organization',
      },
    );
  });

  emailAfterCommit(admins, 'Action needed on your TenderBridge registration', reason);
  return { status: org.status, reason };
}

export async function suspendOrganization(
  actor: Actor,
  id: string,
  reason: string,
  ctx: RefreshContext,
) {
  const org = await prisma.organization.findUnique({ where: { id } });
  if (!org) throw NotFound('Organization');

  const admins = await orgAdminsOf(id);

  const suspended = await prisma.$transaction(async (tx) => {
    const suspended = await tx.organization.update({ where: { id }, data: { status: 'SUSPENDED' } });

    await writeAudit(tx, {
      action: 'organization.suspended',
      entityType: 'Organization',
      entityId: id,
      summary: `${actor.email} suspended "${org.name}": ${reason}`,
      severity: 'SECURITY',
      organizationId: id,
      actor: auditActorOf(actor, ctx),
      before: { status: org.status },
      after: { status: 'SUSPENDED', reason },
    });

    await notifyMany(
      tx,
      admins.map((a) => a.id),
      {
        type: 'VENDOR_SUSPENDED',
        title: 'Your organization has been suspended',
        body: reason,
        entityType: 'Organization',
        entityId: id,
        link: '/organization',
      },
    );

    return suspended;
  });

  bustOrgCache(id);
  emailAfterCommit(admins, 'Your TenderBridge organization is suspended', reason);
  return suspended;
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                      */
/* -------------------------------------------------------------------------- */

/** Every money field leaves as a fixed-2 string, never a JS number (00 §6). */
export async function platformStats(): Promise<PlatformStats> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

  const [
    orgTotal,
    orgActive,
    orgPending,
    vendorTotal,
    vendorApproved,
    vendorPending,
    vendorBlacklisted,
    tenderTotal,
    tenderLive,
    tenderAwarded,
    poAggregate,
    invoiceAggregate,
    paymentAggregate,
    userTotal,
    userActive,
    auditRows,
    unsentNotifications,
    chain,
  ] = await Promise.all([
    prisma.organization.count(),
    prisma.organization.count({ where: { status: 'ACTIVE' } }),
    prisma.organization.count({ where: { status: 'PENDING_APPROVAL' } }),
    prisma.vendor.count(),
    prisma.vendor.count({ where: { status: 'APPROVED' } }),
    prisma.vendor.count({ where: { status: 'PENDING_APPROVAL' } }),
    prisma.vendor.count({ where: { status: 'BLACKLISTED' } }),
    prisma.tender.count(),
    prisma.tender.count({ where: { status: 'PUBLISHED' } }),
    prisma.tender.count({ where: { status: 'AWARDED' } }),
    prisma.purchaseOrder.aggregate({ _sum: { totalAmount: true } }),
    prisma.invoice.aggregate({ _sum: { totalAmount: true } }),
    // Gross is what settles an invoice; net is only what left the bank (plan 13).
    prisma.payment.aggregate({ _sum: { grossAmount: true } }),
    prisma.user.count(),
    prisma.user.count({ where: { lastLoginAt: { gte: sevenDaysAgo } } }),
    prisma.activityLog.count(),
    prisma.notification.count({ where: { emailSentAt: null } }),
    verifyAuditChain(prisma),
  ]);

  return {
    organizations: { total: orgTotal, active: orgActive, pendingApproval: orgPending },
    vendors: {
      total: vendorTotal,
      approved: vendorApproved,
      pendingApproval: vendorPending,
      blacklisted: vendorBlacklisted,
    },
    tenders: { total: tenderTotal, live: tenderLive, awarded: tenderAwarded },
    financial: {
      poValue: toApi(poAggregate._sum.totalAmount ?? 0),
      invoiced: toApi(invoiceAggregate._sum.totalAmount ?? 0),
      paid: toApi(paymentAggregate._sum.grossAmount ?? 0),
    },
    users: { total: userTotal, activeLast7Days: userActive },
    system: {
      auditRows,
      chainValid: chain.valid,
      unsentNotifications,
    },
  };
}
