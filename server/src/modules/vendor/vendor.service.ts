import { Prisma, type Vendor } from '@prisma/client';
import {
  gstinMatchesPan,
  validateGstin,
  validatePan,
  type CreateVendorInput,
  type DuplicateWarning,
  type UpdateVendorInput,
  type VendorQuery,
  type VendorStatus,
} from '@tb/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError, BusinessRule, Conflict, NotFound } from '../../lib/errors.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { prisma } from '../../lib/prisma.js';
import type { Actor } from '../../middleware/authenticate.js';
import { bustVendorCache } from '../../middleware/requireApprovedVendor.js';
import { createInvitation } from '../invitation/invitation.service.js';
import type { RefreshContext } from '../auth/token.service.js';
import { assertTransition, type VendorAction } from './vendor.stateMachine.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext) => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

const withCategories = { categories: true } as const;

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

/** The vendor row is the tenant boundary, so it is scoped by its own id. */
export async function loadOwnVendor(actor: Actor) {
  if (!actor.vendorId) throw NotFound('Vendor');
  const vendor = await prisma.vendor.findUnique({
    where: { id: actor.vendorId },
    include: withCategories,
  });
  if (!vendor) throw NotFound('Vendor');
  return vendor;
}

export async function loadVendor(id: string) {
  const vendor = await prisma.vendor.findUnique({ where: { id }, include: withCategories });
  if (!vendor) throw NotFound('Vendor');
  return vendor;
}

/* -------------------------------------------------------------------------- */
/* KYC                                                                        */
/* -------------------------------------------------------------------------- */

export interface KycFailure {
  path: string;
  message: string;
}

/**
 * Every failure at once (06 §5). A reviewer fixing eight things one round-trip
 * at a time will hate the app, and the vendor will give up before approval.
 */
export async function missingKyc(vendor: Vendor): Promise<KycFailure[]> {
  const failures: KycFailure[] = [];

  if (!vendor.gstin) {
    failures.push({ path: 'gstin', message: 'GSTIN is required' });
  } else {
    const result = validateGstin(vendor.gstin);
    if (!result.valid) {
      failures.push({ path: 'gstin', message: result.message ?? 'GSTIN is invalid' });
    } else if (result.stateCode !== vendor.stateCode) {
      // A GSTIN starting 27 on a vendor claiming Gujarat is a typo or fraud, and
      // it produces the wrong tax regime on every purchase order.
      failures.push({
        path: 'gstin',
        message: `GSTIN state ${result.stateCode} does not match the vendor state code ${vendor.stateCode}`,
      });
    } else if (vendor.pan && !gstinMatchesPan(vendor.gstin, vendor.pan)) {
      failures.push({ path: 'gstin', message: 'GSTIN does not embed the declared PAN' });
    }
  }

  if (!vendor.pan) failures.push({ path: 'pan', message: 'PAN is required' });
  else if (!validatePan(vendor.pan)) failures.push({ path: 'pan', message: 'PAN format is invalid' });

  if (!vendor.addressLine1 || !vendor.city || !vendor.state || !vendor.pincode) {
    failures.push({ path: 'address', message: 'Complete address is required' });
  }
  if (!/^\d{2}$/.test(vendor.stateCode)) {
    failures.push({ path: 'address', message: 'Valid GST state code is required' });
  }

  const [contacts, documents, categories] = await Promise.all([
    prisma.user.count({ where: { vendorId: vendor.id } }),
    prisma.document.findMany({ where: { vendorId: vendor.id }, select: { type: true } }),
    prisma.vendor.findUnique({
      where: { id: vendor.id },
      select: { _count: { select: { categories: true } } },
    }),
  ]);

  if (contacts === 0) failures.push({ path: 'contact', message: 'At least one contact user is required' });

  const types = new Set(documents.map((doc) => doc.type));
  if (!types.has('VENDOR_GST_CERTIFICATE')) {
    failures.push({ path: 'documents.gst', message: 'GST certificate must be uploaded' });
  }
  if (!types.has('VENDOR_PAN')) {
    failures.push({ path: 'documents.pan', message: 'PAN card must be uploaded' });
  }
  if (!types.has('VENDOR_CANCELLED_CHEQUE')) {
    failures.push({
      path: 'documents.cheque',
      message: 'Cancelled cheque must be uploaded before any payment can be made',
    });
  }

  if ((categories?._count.categories ?? 0) === 0) {
    failures.push({ path: 'categories', message: 'At least one category must be selected' });
  }

  return failures;
}

/**
 * Soft duplicate signals. A shared GSTIN is a hard block (the column is unique),
 * but a shared PAN, bank account or email domain is a *warning* with a link:
 * "this PAN matches Beta Systems, approved four months ago" is a compliance
 * feature, not an error.
 */
export async function duplicateWarnings(vendor: Vendor): Promise<DuplicateWarning[]> {
  const warnings: DuplicateWarning[] = [];
  const domain = vendor.email.split('@')[1];

  const candidates = await prisma.vendor.findMany({
    where: {
      id: { not: vendor.id },
      OR: [
        ...(vendor.pan ? [{ pan: vendor.pan }] : []),
        ...(vendor.bankAccountNumber ? [{ bankAccountNumber: vendor.bankAccountNumber }] : []),
        ...(domain ? [{ email: { endsWith: `@${domain}` } }] : []),
      ],
    },
    select: {
      id: true,
      companyName: true,
      pan: true,
      bankAccountNumber: true,
      email: true,
      status: true,
    },
  });

  for (const other of candidates) {
    if (vendor.pan && other.pan === vendor.pan) {
      warnings.push({
        kind: 'pan',
        message: `PAN matches ${other.companyName} (${other.status})`,
        vendorId: other.id,
        vendorName: other.companyName,
      });
    }
    if (vendor.bankAccountNumber && other.bankAccountNumber === vendor.bankAccountNumber) {
      warnings.push({
        kind: 'bank_account',
        message: `Bank account matches ${other.companyName} (${other.status})`,
        vendorId: other.id,
        vendorName: other.companyName,
      });
    }
    if (domain && other.email.endsWith(`@${domain}`)) {
      warnings.push({
        kind: 'email_domain',
        message: `Email domain @${domain} is shared with ${other.companyName}`,
        vendorId: other.id,
        vendorName: other.companyName,
      });
    }
  }

  return warnings;
}

/* -------------------------------------------------------------------------- */
/* Self-service                                                               */
/* -------------------------------------------------------------------------- */

/** Translate the unique-GSTIN violation instead of leaking a raw Prisma error. */
function translateDuplicate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = Array.isArray(error.meta?.target) ? error.meta.target.join(', ') : String(error.meta?.target ?? '');
    if (target.includes('gstin')) {
      throw Conflict('vendor.duplicate_gstin', 'A vendor with this GSTIN already exists');
    }
    if (target.includes('email')) {
      throw Conflict('vendor.duplicate_email', 'A vendor with this email already exists');
    }
  }
  throw error;
}

export async function updateOwnVendor(actor: Actor, input: UpdateVendorInput, ctx: RefreshContext) {
  const vendor = await loadOwnVendor(actor);

  // Cross-validate before writing: state code and GSTIN must agree (06 §4).
  const nextGstin = input.gstin === undefined ? vendor.gstin : input.gstin;
  const nextStateCode = input.stateCode ?? vendor.stateCode;
  if (nextGstin) {
    const result = validateGstin(nextGstin);
    if (result.valid && result.stateCode !== nextStateCode) {
      throw BusinessRule(
        'vendor.gstin_state_mismatch',
        `GSTIN state ${result.stateCode} does not match the state code ${nextStateCode}`,
      );
    }
  }

  const updated = await prisma
    .$transaction(async (tx) => {
      const updated = await tx.vendor.update({
        where: { id: vendor.id },
        data: input,
        include: withCategories,
      });

      await writeAudit(tx, {
        action: 'vendor.updated',
        entityType: 'Vendor',
        entityId: vendor.id,
        summary: `${actor.email} updated the vendor profile`,
        vendorId: vendor.id,
        actor: auditActorOf(actor, ctx),
        // Bank fields are recorded as changed, never with their values.
        after: Object.fromEntries(
          Object.keys(input).map((key) => [key, key.startsWith('bank') ? '[changed]' : (input as Record<string, unknown>)[key] ?? null]),
        ) as Prisma.InputJsonValue,
      });

      return updated;
    })
    .catch(translateDuplicate);

  bustVendorCache(vendor.id);
  return updated;
}

export async function setOwnCategories(actor: Actor, categoryIds: string[], ctx: RefreshContext) {
  const vendor = await loadOwnVendor(actor);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.vendor.update({
      where: { id: vendor.id },
      data: { categories: { set: categoryIds.map((id) => ({ id })) } },
      include: withCategories,
    });

    await writeAudit(tx, {
      action: 'vendor.categories_updated',
      entityType: 'Vendor',
      entityId: vendor.id,
      summary: `${actor.email} set ${categoryIds.length} categor${categoryIds.length === 1 ? 'y' : 'ies'}`,
      vendorId: vendor.id,
      actor: auditActorOf(actor, ctx),
      after: { categoryIds },
    });

    return updated;
  });
}

/* -------------------------------------------------------------------------- */
/* Directory                                                                  */
/* -------------------------------------------------------------------------- */

export async function listVendors(query: VendorQuery) {
  const where: Prisma.VendorWhereInput = {
    // Buyers see approved vendors by default; the platform can ask for others.
    status: query.status ?? 'APPROVED',
    ...(query.search
      ? {
          OR: [
            { companyName: { contains: query.search, mode: 'insensitive' } },
            { legalName: { contains: query.search, mode: 'insensitive' } },
            { city: { contains: query.search, mode: 'insensitive' } },
            { gstin: { contains: query.search.toUpperCase() } },
          ],
        }
      : {}),
    ...(query.categoryId ? { categories: { some: { id: query.categoryId } } } : {}),
    ...(query.minRating !== undefined ? { rating: { gte: query.minRating } } : {}),
    ...(query.state ? { stateCode: query.state } : {}),
  };

  /**
   * A vendor with no history has `rating = null`. Postgres sorts NULLs FIRST on
   * DESC, which would put every brand-new vendor at the top of "best rated" —
   * a small bug that makes a demo look broken.
   */
  const orderBy: Prisma.VendorOrderByWithRelationInput =
    query.sort === '-rating'
      ? { rating: { sort: 'desc', nulls: 'last' } }
      : query.sort === 'rating'
        ? { rating: { sort: 'asc', nulls: 'last' } }
        : query.sort === 'companyName'
          ? { companyName: 'asc' }
          : { createdAt: 'desc' };

  const [rows, total] = await Promise.all([
    prisma.vendor.findMany({
      where,
      include: withCategories,
      orderBy,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.vendor.count({ where }),
  ]);

  return { rows, total, page: query.page, limit: query.limit };
}

/** A buyer onboarding a supplier they already work with, plus the contact invite. */
export async function createVendor(actor: Actor, input: CreateVendorInput, ctx: RefreshContext) {
  if (input.gstin) {
    const result = validateGstin(input.gstin);
    if (result.valid && result.stateCode !== input.stateCode) {
      throw BusinessRule(
        'vendor.gstin_state_mismatch',
        `GSTIN state ${result.stateCode} does not match the state code ${input.stateCode}`,
      );
    }
  }

  const vendor = await prisma
    .$transaction(async (tx) => {
      const vendor = await tx.vendor.create({
        data: {
          companyName: input.companyName,
          email: input.email,
          phone: input.phone,
          addressLine1: input.addressLine1,
          addressLine2: input.addressLine2 ?? null,
          city: input.city,
          state: input.state,
          stateCode: input.stateCode,
          pincode: input.pincode,
          gstin: input.gstin ?? null,
          pan: input.pan ?? null,
          ...(input.categoryIds.length
            ? { categories: { connect: input.categoryIds.map((id) => ({ id })) } }
            : {}),
        },
        include: withCategories,
      });

      await writeAudit(tx, {
        action: 'vendor.registered',
        entityType: 'Vendor',
        entityId: vendor.id,
        summary: `${actor.email} registered vendor "${vendor.companyName}"`,
        severity: 'NOTABLE',
        organizationId: actor.organizationId,
        vendorId: vendor.id,
        actor: auditActorOf(actor, ctx),
        after: { companyName: vendor.companyName, status: vendor.status },
      });

      return vendor;
    })
    .catch(translateDuplicate);

  return vendor;
}

/* -------------------------------------------------------------------------- */
/* Status transitions                                                         */
/* -------------------------------------------------------------------------- */

const NOTIFICATION_BY_ACTION = {
  approve: 'VENDOR_APPROVED',
  reject: 'VENDOR_REJECTED',
  suspend: 'VENDOR_SUSPENDED',
  reinstate: 'VENDOR_APPROVED',
  blacklist: 'VENDOR_SUSPENDED',
} as const;

export async function changeVendorStatus(
  actor: Actor,
  id: string,
  action: VendorAction,
  reason: string | null,
  ctx: RefreshContext,
) {
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) throw NotFound('Vendor');

  const nextStatus: VendorStatus = assertTransition(vendor.status, action);

  // Approval is the gate that lets a vendor bid and be paid, so the data those
  // documents depend on has to be complete and valid first.
  if (action === 'approve') {
    const failures = await missingKyc(vendor);
    if (failures.length) {
      throw new AppError(422, 'vendor.incomplete_kyc', 'Approval requires complete KYC', failures);
    }
  }

  const contacts = await prisma.user.findMany({
    where: { vendorId: id, status: 'ACTIVE' },
    select: { id: true, email: true },
  });

  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.vendor.update({
      where: { id },
      data: {
        status: nextStatus,
        statusReason: reason,
        ...(action === 'approve' || action === 'reinstate'
          ? { approvedAt: new Date(), approvedById: actor.userId }
          : {}),
      },
      include: withCategories,
    });

    await writeAudit(tx, {
      action: `vendor.${action}d`.replace('reinstated', 'reinstated'),
      entityType: 'Vendor',
      entityId: id,
      summary: `${actor.email} ${action}d "${vendor.companyName}"${reason ? `: ${reason}` : ''}`,
      severity: action === 'approve' || action === 'reinstate' ? 'NOTABLE' : 'SECURITY',
      vendorId: id,
      actor: auditActorOf(actor, ctx),
      before: { status: vendor.status },
      after: { status: nextStatus, reason },
    });

    await notifyMany(
      tx,
      contacts.map((c) => c.id),
      {
        type: NOTIFICATION_BY_ACTION[action],
        title: `Your vendor account is now ${nextStatus}`,
        body:
          reason ??
          (action === 'approve'
            ? 'You can now be invited to tenders and submit quotations.'
            : `Your account status changed to ${nextStatus}.`),
        entityType: 'Vendor',
        entityId: id,
        link: '/vendor/profile',
      },
    );

    return updated;
  });

  bustVendorCache(id);
  emailAfterCommit(
    contacts,
    `TenderBridge: your vendor account is ${nextStatus}`,
    reason ?? `Your account status changed to ${nextStatus}.`,
  );

  return updated;
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

export const listCategories = () =>
  prisma.category.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export async function createCategory(actor: Actor, input: { name: string; description?: string }) {
  try {
    return await prisma.category.create({
      data: { name: input.name, slug: slugify(input.name), description: input.description ?? null },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw Conflict('category.duplicate', 'A category with this name already exists');
    }
    throw error;
  }
}

/** Invite the vendor's first contact user — reuses the plan 03 invitation flow. */
export async function inviteVendorContact(
  actor: Actor,
  vendorId: string,
  email: string,
  fullName: string | undefined,
  ctx: RefreshContext,
) {
  const vendorActor: Actor = {
    ...actor,
    role: 'VENDOR',
    organizationId: null,
    vendorId,
    isPlatformAdmin: false,
  };
  return createInvitation(vendorActor, { email, fullName, role: 'VENDOR' }, ctx);
}
