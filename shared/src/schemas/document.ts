import { z } from 'zod';
import {
  AUDIT_SEVERITIES,
  DOCUMENT_TYPES,
  NOTIFICATION_TYPES,
  type DocumentType,
} from '../enums.js';
import { paginationQuerySchema, uuidSchema } from './common.js';

/**
 * Documents, notifications and activity (plan 14).
 *
 * Three cross-cutting contracts in one file because none is big enough to own
 * its own, and every module from vendor onboarding onward uses all three.
 */

/* -------------------------------------------------------------------------- */
/* Part A — documents                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What a document can hang off. `Document.ownerType` is a plain string column,
 * so this union is the only thing keeping it honest.
 */
export const DOCUMENT_OWNER_TYPES = [
  'ORGANIZATION',
  'VENDOR',
  'TENDER',
  'QUOTATION',
  'PURCHASE_ORDER',
  'DELIVERY',
  'GRN',
  'INVOICE',
  'PAYMENT',
] as const;

export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];

/**
 * Per-type upload rules (plan 14 §A2). **An unlisted type is rejected** — the
 * record is exhaustive over `DocumentType` so adding an enum value without
 * deciding what may be uploaded for it is a compile error, not a hole.
 *
 * Note what appears nowhere: `image/svg+xml`. **SVG is never accepted, for any
 * type.** It is executable XML, and there is no safe way to serve it inline from
 * a user upload.
 */
export const UPLOAD_RULES: Record<DocumentType, { mime: string[]; maxMb: number }> = {
  ORG_GST_CERTIFICATE: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
  ORG_PAN: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
  ORG_LOGO: { mime: ['image/png', 'image/jpeg', 'image/webp'], maxMb: 2 },
  VENDOR_GST_CERTIFICATE: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
  VENDOR_PAN: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
  VENDOR_CANCELLED_CHEQUE: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
  VENDOR_CERTIFICATE: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
  TENDER_ATTACHMENT: {
    mime: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    maxMb: 10,
  },
  QUOTATION_ATTACHMENT: {
    mime: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    maxMb: 10,
  },
  PO_PDF: { mime: ['application/pdf'], maxMb: 5 },
  DELIVERY_CHALLAN: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
  GRN_ATTACHMENT: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
  INVOICE_PDF: { mime: ['application/pdf'], maxMb: 5 },
  PAYMENT_PROOF: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
  OTHER: { mime: ['application/pdf', 'image/jpeg', 'image/png'], maxMb: 5 },
};

/** The hard ceiling multer enforces before any rule is consulted. */
export const MAX_UPLOAD_MB = 10;

/**
 * Types whose download is itself audited. A GST certificate or a cancelled
 * cheque carries bank and tax identity; who read it, and when, is worth keeping.
 */
export const SENSITIVE_DOCUMENT_TYPES: DocumentType[] = [
  'ORG_GST_CERTIFICATE',
  'ORG_PAN',
  'VENDOR_GST_CERTIFICATE',
  'VENDOR_PAN',
  'VENDOR_CANCELLED_CHEQUE',
  'PAYMENT_PROOF',
];

export const uploadDocumentSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES),
    ownerType: z.enum(DOCUMENT_OWNER_TYPES),
    ownerId: uuidSchema,
  })
  .strict();

export const documentQuerySchema = paginationQuerySchema.extend({
  ownerType: z.enum(DOCUMENT_OWNER_TYPES).optional(),
  ownerId: uuidSchema.optional(),
  type: z.enum(DOCUMENT_TYPES).optional(),
});

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;
export type DocumentQuery = z.infer<typeof documentQuerySchema>;

export interface DocumentDto {
  id: string;
  ownerType: string;
  ownerId: string;
  type: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string | null;
  uploadedById: string;
  uploadedByName: string | null;
  /** True when this actor may still delete it (uploader, within 24h, unreferenced). */
  canDelete: boolean;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Part B — notifications                                                    */
/* -------------------------------------------------------------------------- */

export const notificationQuerySchema = paginationQuerySchema.extend({
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  type: z.enum(NOTIFICATION_TYPES).optional(),
});

export type NotificationQuery = z.infer<typeof notificationQuerySchema>;

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  link: string | null;
  readAt: string | null;
  /** Null when no email was attempted for this event type. */
  emailSentAt: string | null;
  emailError: string | null;
  createdAt: string;
}

export interface UnreadCountDto {
  unread: number;
}

/** What the bell screen renders: which events email, and which are in-app only. */
export interface NotificationPreferenceDto {
  type: string;
  label: string;
  /** Whether this event sends email under the current policy (plan 14 §B2). */
  email: boolean;
  inApp: true;
}

/* -------------------------------------------------------------------------- */
/* Part C — activity                                                         */
/* -------------------------------------------------------------------------- */

export const activityQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: uuidSchema.optional(),
  severity: z.enum(AUDIT_SEVERITIES).optional(),
  action: z.string().trim().min(1).max(80).optional(),
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export interface ActivityDto {
  id: string;
  sequence: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  severity: string;
  actor: { id: string | null; email: string | null; role: string | null };
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface ChainVerificationDto {
  valid: boolean;
  rowsChecked: number;
  durationMs: number;
  /** The first row whose hash does not reproduce. Points straight at tampering. */
  firstInvalidSequence: string | null;
}
