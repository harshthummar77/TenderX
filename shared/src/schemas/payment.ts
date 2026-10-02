import { z } from 'zod';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../enums.js';
import {
  isoDateTimeSchema,
  moneySchema,
  paginationQuerySchema,
  uuidSchema,
} from './common.js';

/**
 * Payments (plan 13).
 *
 * **Payments are recorded, not executed.** There is no gateway: the money moves
 * through the buyer's bank and this system is the register. That is what real
 * procurement software does at this scale, and it is a deliberate scope
 * decision rather than a missing feature.
 *
 * Note what the schema does **not** accept: `netAmount`. It is
 * `gross − tds − retention − other`, computed server-side, because a
 * client-supplied net is an invitation to a ledger that does not balance.
 */

/**
 * TDS sections this system suggests. Rates are the common ones and the user can
 * always override both — a suggestion removes the error-prone step without ever
 * deducting tax automatically.
 */
export const TDS_SECTIONS = {
  '194C': { label: 'Contracts and supply', percent: '2.00' },
  '194J': { label: 'Professional or technical services', percent: '10.00' },
  '194Q': { label: 'Purchase of goods', percent: '0.10' },
} as const;

export type TdsSection = keyof typeof TDS_SECTIONS;

export const tdsSectionSchema = z.enum(['194C', '194J', '194Q']);

/** Bank transfer methods, which are the ones that need the vendor's account. */
export const BANK_METHODS = ['NEFT', 'RTGS', 'IMPS'] as const;

export const createPaymentSchema = z
  .object({
    invoiceId: uuidSchema,
    /** What is applied against the invoice balance. */
    grossAmount: moneySchema,
    tdsAmount: moneySchema.default('0.00'),
    tdsSection: tdsSectionSchema.optional(),
    retentionAmount: moneySchema.default('0.00'),
    otherDeduction: moneySchema.default('0.00'),
    method: z.enum(PAYMENT_METHODS),
    /** UTR or cheque number. Optional at recording, required at completion. */
    referenceNumber: z.string().trim().max(60).optional(),
    paidAt: isoDateTimeSchema,
    remarks: z.string().trim().max(1000).optional(),
  })
  .strict();

export const completePaymentSchema = z
  .object({
    /** The bank's own reference — a completion without one is unauditable. */
    referenceNumber: z.string().trim().min(3).max(60),
    valueDate: isoDateTimeSchema.optional(),
  })
  .strict();

export const PAYMENT_FAILURE_REASON_MIN_LENGTH = 10;

export const failPaymentSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(
        PAYMENT_FAILURE_REASON_MIN_LENGTH,
        `Say why the bank returned it, in at least ${PAYMENT_FAILURE_REASON_MIN_LENGTH} characters`,
      )
      .max(1000),
  })
  .strict();

export const cancelPaymentSchema = z
  .object({ reason: z.string().trim().min(5).max(1000) })
  .strict();

export const paymentQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PAYMENT_STATUSES).optional(),
  vendorId: uuidSchema.optional(),
  invoiceId: uuidSchema.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type CompletePaymentInput = z.infer<typeof completePaymentSchema>;
export type FailPaymentInput = z.infer<typeof failPaymentSchema>;
export type CancelPaymentInput = z.infer<typeof cancelPaymentSchema>;
export type PaymentQuery = z.infer<typeof paymentQuerySchema>;

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

export interface PaymentDto {
  id: string;
  paymentNumber: string;
  status: string;
  invoiceId: string;
  invoiceReference: string | null;
  vendorInvoiceNumber: string | null;
  poNumber: string | null;
  vendorId: string;
  vendorName: string | null;
  /** Applied against the invoice balance — this is what settles it. */
  grossAmount: string;
  tdsAmount: string;
  tdsSection: string | null;
  retentionAmount: string;
  otherDeduction: string;
  /** What actually left the bank. */
  netAmount: string;
  netAmountInWords: string;
  method: string;
  referenceNumber: string | null;
  paidAt: string;
  valueDate: string | null;
  recordedById: string;
  approvedById: string | null;
  approvedAt: string | null;
  remarks: string | null;
  failureReason: string | null;
  /** The invoice balance after this payment, when it is COMPLETED. */
  invoiceOutstanding: string | null;
  createdAt: string;
}

export interface TdsSuggestionDto {
  section: string;
  percent: string;
  amount: string;
}

export interface PayableRowDto {
  invoiceId: string;
  referenceNumber: string;
  vendorInvoiceNumber: string;
  vendor: { id: string; name: string; bankMasked: string | null };
  poNumber: string | null;
  invoiceDate: string;
  dueDate: string;
  /** Negative when already past due. */
  daysToDue: number;
  totalAmount: string;
  amountPaid: string;
  outstanding: string;
  suggestedTds: TdsSuggestionDto | null;
  matchStatus: string;
  isOverdue: boolean;
  /** Set when something blocks payment despite the invoice being listed. */
  blockedReason: string | null;
}

export interface PayableDto {
  rows: PayableRowDto[];
  totals: { count: number; outstanding: string; overdue: string };
}
