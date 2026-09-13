/**
 * Enums shared by both apps. Every enum here MIRRORS the Prisma enum of the
 * same name, value for value — Prisma is the source of truth, this file is the
 * copy the client is allowed to import. A typo here surfaces as a runtime 500
 * in week 5, so diff this file against server/prisma/schema/enums.prisma
 * whenever either side changes.
 *
 * Each aggregate owns its own status enum. There is deliberately no single
 * shared status type (defect C2).
 */

const asEnum = <const T extends readonly string[]>(values: T) =>
  Object.freeze(Object.fromEntries(values.map((v) => [v, v])) as { [K in T[number]]: K });

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

export const ROLES = ['PLATFORM_ADMIN', 'ORG_ADMIN', 'ORG_OFFICER', 'VENDOR'] as const;
export type Role = (typeof ROLES)[number];
export const Role = asEnum(ROLES);

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const UserStatus = asEnum(USER_STATUSES);

export const ORGANIZATION_STATUSES = ['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];
export const OrganizationStatus = asEnum(ORGANIZATION_STATUSES);

export const VENDOR_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'BLACKLISTED',
] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];
export const VendorStatus = asEnum(VENDOR_STATUSES);

/* -------------------------------------------------------------------------- */
/* Sourcing                                                                   */
/* -------------------------------------------------------------------------- */

/** Sourcing lifecycle only — it says nothing about POs, invoices or payments. */
export const TENDER_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'BIDDING_CLOSED',
  'UNDER_EVALUATION',
  'PENDING_APPROVAL',
  'AWARDED',
  'CANCELLED',
  'CLOSED',
] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];
export const TenderStatus = asEnum(TENDER_STATUSES);

export const EVALUATION_METHODS = ['LOWEST_PRICE', 'WEIGHTED_SCORE'] as const;
export type EvaluationMethod = (typeof EVALUATION_METHODS)[number];
export const EvaluationMethod = asEnum(EVALUATION_METHODS);

export const QUOTATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'WITHDRAWN',
  'REJECTED',
  'SHORTLISTED',
  'AWARDED',
  'LOST',
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
export const QuotationStatus = asEnum(QUOTATION_STATUSES);

export const APPROVAL_ENTITIES = ['TENDER_AWARD', 'INVOICE', 'PAYMENT'] as const;
export type ApprovalEntity = (typeof APPROVAL_ENTITIES)[number];
export const ApprovalEntity = asEnum(APPROVAL_ENTITIES);

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const ApprovalStatus = asEnum(APPROVAL_STATUSES);

/* -------------------------------------------------------------------------- */
/* Procurement                                                                */
/* -------------------------------------------------------------------------- */

export const PO_STATUSES = [
  'DRAFT',
  'ISSUED',
  'ACCEPTED',
  'REJECTED',
  'CANCELLED',
  'CLOSED',
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export const PoStatus = asEnum(PO_STATUSES);

export const FULFILMENT_STATUSES = [
  'NOT_STARTED',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'SHORT_CLOSED',
] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];
export const FulfilmentStatus = asEnum(FULFILMENT_STATUSES);

export const DELIVERY_STATUSES = ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const DeliveryStatus = asEnum(DELIVERY_STATUSES);

export const GRN_STATUSES = ['ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED'] as const;
export type GrnStatus = (typeof GRN_STATUSES)[number];
export const GrnStatus = asEnum(GRN_STATUSES);

export const INVOICE_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED_FOR_PAYMENT',
  'REJECTED',
  'PARTIALLY_PAID',
  'PAID',
  'CANCELLED',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const InvoiceStatus = asEnum(INVOICE_STATUSES);

export const MATCH_STATUSES = ['NOT_RUN', 'MATCHED', 'EXCEPTION', 'OVERRIDDEN'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export const MatchStatus = asEnum(MATCH_STATUSES);

export const PAYMENT_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PaymentStatus = asEnum(PAYMENT_STATUSES);

export const PAYMENT_METHODS = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CASH'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PaymentMethod = asEnum(PAYMENT_METHODS);

/** INTRA_STATE → CGST + SGST, INTER_STATE → IGST (plan 10). */
export const TAX_REGIMES = ['INTRA_STATE', 'INTER_STATE', 'EXEMPT'] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];
export const TaxRegime = asEnum(TAX_REGIMES);

/* -------------------------------------------------------------------------- */
/* Platform                                                                   */
/* -------------------------------------------------------------------------- */

export const DOCUMENT_TYPES = [
  'ORG_GST_CERTIFICATE',
  'ORG_PAN',
  'ORG_LOGO',
  'VENDOR_GST_CERTIFICATE',
  'VENDOR_PAN',
  'VENDOR_CANCELLED_CHEQUE',
  'VENDOR_CERTIFICATE',
  'TENDER_ATTACHMENT',
  'QUOTATION_ATTACHMENT',
  'PO_PDF',
  'DELIVERY_CHALLAN',
  'GRN_ATTACHMENT',
  'INVOICE_PDF',
  'PAYMENT_PROOF',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DocumentType = asEnum(DOCUMENT_TYPES);

export const DOC_SEQUENCE_TYPES = [
  'TENDER',
  'QUOTATION',
  'PURCHASE_ORDER',
  'GRN',
  'INVOICE',
  'PAYMENT',
] as const;
export type DocSequenceType = (typeof DOC_SEQUENCE_TYPES)[number];
export const DocSequenceType = asEnum(DOC_SEQUENCE_TYPES);

export const AUDIT_SEVERITIES = ['INFO', 'NOTABLE', 'SECURITY'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];
export const AuditSeverity = asEnum(AUDIT_SEVERITIES);

export const NOTIFICATION_TYPES = [
  'VENDOR_APPROVED',
  'VENDOR_REJECTED',
  'VENDOR_SUSPENDED',
  'TENDER_INVITED',
  'TENDER_PUBLISHED',
  'TENDER_CLOSING_SOON',
  'TENDER_BIDDING_CLOSED',
  'TENDER_CANCELLED',
  'QUOTATION_RECEIVED',
  'QUOTATION_WITHDRAWN',
  'APPROVAL_REQUESTED',
  'APPROVAL_APPROVED',
  'APPROVAL_REJECTED',
  'TENDER_AWARDED',
  'QUOTATION_LOST',
  'PO_ISSUED',
  'PO_ACCEPTED',
  'PO_REJECTED',
  'DELIVERY_DISPATCHED',
  'GRN_RECORDED',
  'GRN_REJECTION',
  'INVOICE_SUBMITTED',
  'INVOICE_MATCH_EXCEPTION',
  'INVOICE_APPROVED',
  'INVOICE_REJECTED',
  'PAYMENT_RECORDED',
  'PAYMENT_COMPLETED',
  'USER_INVITED',
  'PASSWORD_CHANGED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const NotificationType = asEnum(NOTIFICATION_TYPES);

/* -------------------------------------------------------------------------- */
/* Role helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Roles that belong to a buyer organization (carry `organizationId`). */
export const ORG_ROLES: readonly Role[] = [Role.ORG_ADMIN, Role.ORG_OFFICER];

export const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_ADMIN: 'Platform Admin',
  ORG_ADMIN: 'Organization Admin',
  ORG_OFFICER: 'Procurement Officer',
  VENDOR: 'Vendor',
};
