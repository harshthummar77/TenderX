import { z } from 'zod';
import { INVOICE_STATUSES, MATCH_STATUSES } from '../enums.js';
import {
  isoDateTimeSchema,
  moneySchema,
  paginationQuerySchema,
  positiveQuantitySchema,
  uuidSchema,
} from './common.js';

/**
 * Vendor-raised invoices and the three-way match (plan 12).
 *
 * **The supplier raises the invoice.** The buyer verifies it against what was
 * ordered and what was actually received, and pays only what matches. A
 * buyer-generated invoice cannot be wrong, so there would be nothing to verify
 * and no reason for this module to exist — inverting that one relationship is
 * what makes this an accounts-payable system.
 *
 * Nothing here accepts a tax figure or a total. Every amount is recomputed
 * server-side from the quantity, the price and the **purchase order's frozen tax
 * regime**, so a vendor cannot invent the arithmetic they want to be paid on.
 */

export const invoiceItemSchema = z
  .object({
    purchaseOrderItemId: uuidSchema,
    quantity: positiveQuantitySchema,
    unitPrice: moneySchema,
    discountPercent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Must be a percentage')
      .refine((v) => Number(v) <= 100, 'Cannot exceed 100')
      .default('0.00'),
  })
  .strict();

const invoiceBody = {
  vendorInvoiceNumber: z.string().trim().min(1).max(60),
  invoiceDate: isoDateTimeSchema,
  freightAmount: moneySchema.default('0.00'),
};

export const createInvoiceSchema = z
  .object({
    ...invoiceBody,
    items: z.array(invoiceItemSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.items.map((item) => item.purchaseOrderItemId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Each order line may appear only once on an invoice',
      });
    }
  });

export const updateInvoiceSchema = z
  .object({
    vendorInvoiceNumber: invoiceBody.vendorInvoiceNumber.optional(),
    invoiceDate: isoDateTimeSchema.optional(),
    freightAmount: moneySchema.optional(),
    items: z.array(invoiceItemSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/** Submission carries no body — the stored draft is the claim. */
export const submitInvoiceSchema = z.object({}).strict().optional().default({});

export const approveInvoiceSchema = z
  .object({ comment: z.string().trim().max(2000).optional() })
  .strict()
  .optional()
  .default({});

export const INVOICE_REJECTION_REASON_MIN_LENGTH = 20;

export const rejectInvoiceSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(
        INVOICE_REJECTION_REASON_MIN_LENGTH,
        `Tell the vendor what to fix, in at least ${INVOICE_REJECTION_REASON_MIN_LENGTH} characters`,
      )
      .max(2000),
  })
  .strict();

/**
 * An override is longer than a rejection on purpose. Rejecting costs the vendor
 * a correction; overriding commits the organization to paying something that did
 * not verify, and it lands on the auditor's report under a name.
 */
export const OVERRIDE_REASON_MIN_LENGTH = 30;

export const overrideMatchSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(
        OVERRIDE_REASON_MIN_LENGTH,
        `Justify the override in at least ${OVERRIDE_REASON_MIN_LENGTH} characters`,
      )
      .max(2000),
  })
  .strict();

export const invoiceQuerySchema = paginationQuerySchema.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  matchStatus: z.enum(MATCH_STATUSES).optional(),
  vendorId: uuidSchema.optional(),
  purchaseOrderId: uuidSchema.optional(),
  /** Approved-or-partly-paid invoices whose due date has passed. */
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type InvoiceItemInput = z.infer<typeof invoiceItemSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type RejectInvoiceInput = z.infer<typeof rejectInvoiceSchema>;
export type OverrideMatchInput = z.infer<typeof overrideMatchSchema>;
export type InvoiceQuery = z.infer<typeof invoiceQuerySchema>;

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

export interface MatchCheckDto {
  code: string;
  label: string;
  status: string;
  expected?: string;
  actual?: string;
  variance?: string;
  detail?: string;
}

export interface InvoiceItemDto {
  id: string;
  purchaseOrderItemId: string;
  srNo: number | null;
  description: string;
  hsnCode: string | null;
  unit: string;
  quantity: string;
  unitPrice: string;
  taxableValue: string;
  taxRatePercent: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal: string;
}

export interface InvoiceDto {
  id: string;
  referenceNumber: string;
  vendorInvoiceNumber: string;
  purchaseOrderId: string;
  poNumber: string | null;
  vendorId: string;
  vendorName: string | null;
  status: string;
  matchStatus: string;
  /** The stored reasoning, rendered by the UI as a checklist. */
  matchResult: MatchCheckDto[] | null;
  matchRunAt: string | null;
  invoiceDate: string;
  dueDate: string;
  taxRegime: string | null;
  subtotal: string;
  discountAmount: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  freightAmount: string;
  roundOff: string;
  totalAmount: string;
  totalAmountInWords: string;
  amountPaid: string;
  outstanding: string;
  items: InvoiceItemDto[];
  submittedAt: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  overriddenById: string | null;
  overrideReason: string | null;
  paidAt: string | null;
  /** Null when payable; otherwise why not (plan 12 §8). */
  payableBlocker: string | null;
  daysOverdue: number;
  createdAt: string;
}

export interface InvoiceableLineDto {
  purchaseOrderItemId: string;
  srNo: number;
  description: string;
  hsnCode: string | null;
  unit: string;
  ordered: string;
  accepted: string;
  alreadyInvoiced: string;
  /** `accepted − alreadyInvoiced`. Accept the prefill and you cannot except. */
  invoiceable: string;
  unitPrice: string;
  taxRatePercent: string;
}

export interface InvoiceableDto {
  purchaseOrder: {
    id: string;
    poNumber: string;
    taxRegime: string;
    status: string;
  };
  canInvoice: boolean;
  lines: InvoiceableLineDto[];
  warnings: string[];
}

export interface AgeingBucketDto {
  label: string;
  count: number;
  amount: string;
}

export interface AgeingDto {
  asOf: string;
  buckets: AgeingBucketDto[];
  total: { count: number; amount: string };
  byVendor: {
    vendorId: string;
    name: string;
    outstanding: string;
    oldestDays: number;
  }[];
}
