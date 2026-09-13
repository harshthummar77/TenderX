/**
 * Enums shared by both apps. Every enum here MUST mirror the Prisma enum of the
 * same name exactly — Prisma is the source of truth, this file is the copy the
 * client is allowed to import.
 *
 * Plan 02 adds the aggregate status enums (TenderStatus, QuotationStatus,
 * PurchaseOrderStatus, GrnStatus, InvoiceStatus, PaymentStatus, ...).
 * Each aggregate owns its own enum — never one shared status column (00 §2 C2).
 */

export const Role = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  ORG_ADMIN: 'ORG_ADMIN',
  ORG_OFFICER: 'ORG_OFFICER',
  VENDOR: 'VENDOR',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const ROLES = Object.values(Role);

/** Roles that belong to a buyer organization (carry `organizationId`). */
export const ORG_ROLES: Role[] = [Role.ORG_ADMIN, Role.ORG_OFFICER];

export const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_ADMIN: 'Platform Admin',
  ORG_ADMIN: 'Organization Admin',
  ORG_OFFICER: 'Procurement Officer',
  VENDOR: 'Vendor',
};
