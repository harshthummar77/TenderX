import { Role } from './enums.js';

/**
 * One flat catalogue of `resource:action` strings, and one matrix mapping roles
 * to them. Imported by BOTH apps: the server enforces it, the client uses it to
 * hide what the user cannot do.
 *
 * Hiding a button is convenience. The 403 is the security (04 §7).
 */
export const PERMISSIONS = {
  // platform
  PLATFORM_MANAGE: 'platform:manage',
  ORG_APPROVE: 'organization:approve',

  // organization
  ORG_VIEW: 'organization:view',
  ORG_UPDATE: 'organization:update',
  ORG_MEMBER_MANAGE: 'organization:member_manage',

  // vendor
  VENDOR_VIEW: 'vendor:view',
  VENDOR_CREATE: 'vendor:create',
  VENDOR_UPDATE_SELF: 'vendor:update_self',
  VENDOR_APPROVE: 'vendor:approve',
  VENDOR_BLACKLIST: 'vendor:blacklist',

  // tender
  TENDER_VIEW: 'tender:view',
  TENDER_CREATE: 'tender:create',
  TENDER_UPDATE: 'tender:update',
  TENDER_PUBLISH: 'tender:publish',
  TENDER_CANCEL: 'tender:cancel',

  // quotation
  QUOTATION_VIEW_OWN: 'quotation:view_own',
  QUOTATION_SUBMIT: 'quotation:submit',
  /** Buyer side; bids stay sealed until the deadline regardless of this. */
  QUOTATION_VIEW_ALL: 'quotation:view_all',

  // evaluation & approval
  EVALUATION_RUN: 'evaluation:run',
  EVALUATION_RECOMMEND: 'evaluation:recommend',
  /** ORG_ADMIN only — separation of duties. */
  APPROVAL_DECIDE: 'approval:decide',

  // purchase order
  PO_VIEW: 'po:view',
  PO_ISSUE: 'po:issue',
  /** Vendor accepts or rejects. */
  PO_RESPOND: 'po:respond',
  PO_CANCEL: 'po:cancel',

  // fulfilment
  DELIVERY_CREATE: 'delivery:create',
  GRN_CREATE: 'grn:create',

  // finance
  INVOICE_SUBMIT: 'invoice:submit',
  INVOICE_VIEW: 'invoice:view',
  INVOICE_APPROVE: 'invoice:approve',
  INVOICE_OVERRIDE: 'invoice:override',
  PAYMENT_RECORD: 'payment:record',
  PAYMENT_VIEW: 'payment:view',

  // platform-wide
  REPORT_VIEW: 'report:view',
  AUDIT_VIEW: 'audit:view',
  DOCUMENT_UPLOAD: 'document:upload',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

const P = PERMISSIONS;

/**
 * The role matrix. Read the two notes below before changing a single line.
 *
 * **Separation of duties.** ORG_OFFICER deliberately holds none of
 * APPROVAL_DECIDE, INVOICE_APPROVE, INVOICE_OVERRIDE, PAYMENT_RECORD,
 * TENDER_CANCEL or PO_ISSUE. The officer runs the process — creates tenders,
 * evaluates bids, recommends a winner, records goods receipt. The admin
 * authorises money. One person can never take a purchase from tender to
 * payment alone.
 *
 * **PLATFORM_ADMIN is read-only across tenants.** It approves organizations and
 * vendors and reads audit logs, and holds no create or payment permission on
 * any tenant's data. A platform operator has no business issuing a customer's
 * purchase order.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  PLATFORM_ADMIN: [
    P.PLATFORM_MANAGE,
    P.ORG_APPROVE,
    P.ORG_VIEW,
    P.VENDOR_VIEW,
    P.VENDOR_APPROVE,
    P.VENDOR_BLACKLIST,
    P.TENDER_VIEW,
    P.REPORT_VIEW,
    P.AUDIT_VIEW,
  ],
  ORG_ADMIN: [
    P.ORG_VIEW,
    P.ORG_UPDATE,
    P.ORG_MEMBER_MANAGE,
    P.VENDOR_VIEW,
    P.VENDOR_CREATE,
    P.TENDER_VIEW,
    P.TENDER_CREATE,
    P.TENDER_UPDATE,
    P.TENDER_PUBLISH,
    P.TENDER_CANCEL,
    P.QUOTATION_VIEW_ALL,
    P.EVALUATION_RUN,
    P.EVALUATION_RECOMMEND,
    P.APPROVAL_DECIDE,
    P.PO_VIEW,
    P.PO_ISSUE,
    P.PO_CANCEL,
    P.GRN_CREATE,
    P.INVOICE_VIEW,
    P.INVOICE_APPROVE,
    P.INVOICE_OVERRIDE,
    P.PAYMENT_RECORD,
    P.PAYMENT_VIEW,
    P.REPORT_VIEW,
    P.AUDIT_VIEW,
    P.DOCUMENT_UPLOAD,
  ],
  ORG_OFFICER: [
    P.ORG_VIEW,
    P.VENDOR_VIEW,
    P.VENDOR_CREATE,
    P.TENDER_VIEW,
    P.TENDER_CREATE,
    P.TENDER_UPDATE,
    P.TENDER_PUBLISH,
    P.QUOTATION_VIEW_ALL,
    P.EVALUATION_RUN,
    P.EVALUATION_RECOMMEND,
    P.PO_VIEW,
    P.GRN_CREATE,
    P.INVOICE_VIEW,
    P.PAYMENT_VIEW,
    P.REPORT_VIEW,
    P.DOCUMENT_UPLOAD,
  ],
  VENDOR: [
    P.VENDOR_UPDATE_SELF,
    P.TENDER_VIEW,
    P.QUOTATION_VIEW_OWN,
    P.QUOTATION_SUBMIT,
    P.PO_VIEW,
    P.PO_RESPOND,
    P.DELIVERY_CREATE,
    P.INVOICE_SUBMIT,
    P.INVOICE_VIEW,
    P.PAYMENT_VIEW,
    P.DOCUMENT_UPLOAD,
  ],
};

/** The permissions ORG_OFFICER must never hold. Asserted by the test suite. */
export const SEPARATION_OF_DUTIES_PERMISSIONS: readonly Permission[] = [
  P.APPROVAL_DECIDE,
  P.INVOICE_APPROVE,
  P.INVOICE_OVERRIDE,
  P.PAYMENT_RECORD,
  P.TENDER_CANCEL,
  P.PO_ISSUE,
];

export const hasPermission = (role: Role, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role]?.includes(permission) ?? false;

export const hasAllPermissions = (role: Role, permissions: readonly Permission[]): boolean =>
  permissions.every((p) => hasPermission(role, p));

export const hasAnyPermission = (role: Role, permissions: readonly Permission[]): boolean =>
  permissions.some((p) => hasPermission(role, p));

/** Convenience for the client: `can(role)(P.PAYMENT_RECORD)`. */
export const can = (role: Role | null | undefined) => (permission: Permission) =>
  role ? hasPermission(role, permission) : false;

export { Role };
