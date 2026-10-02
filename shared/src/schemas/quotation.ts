import { z } from 'zod';
import { QUOTATION_STATUSES } from '../enums.js';
import {
  moneySchema,
  paginationQuerySchema,
  positiveQuantitySchema,
  uuidSchema,
} from './common.js';

/**
 * Sealed bidding (08 §1).
 *
 * **The client may send totals; the server ignores every one of them.** The
 * pricing screen computes running totals to show the vendor, and it is simpler
 * for it to PATCH the whole object back than to strip its own fields — so the
 * totals are declared here, and `quotation.service` never reads one. A vendor
 * who posts `grandTotal: "1.00"` gets the correct total stored.
 *
 * They are declared rather than left to `.strict()` on purpose: a silent 422 on
 * a field the UI legitimately renders would be a mysterious autosave failure,
 * and `.strict()` still catches everything genuinely unknown.
 */
const ignoredTotal = moneySchema.optional();

const percentSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Must be a percentage')
  .refine((v) => Number(v) <= 100, 'Cannot exceed 100');

export const quotationItemDraftSchema = z
  .object({
    tenderItemId: uuidSchema,
    quantity: positiveQuantitySchema,
    unitPrice: moneySchema,
    discountPercent: percentSchema.default('0.00'),
    deliveryDays: z.number().int().min(0).max(3650).optional(),
    brandOrMake: z.string().trim().max(200).optional(),
    remarks: z.string().trim().max(1000).optional(),

    // Display-only. Recomputed from quantity, unitPrice, discountPercent and
    // the *tender's* tax rate; whatever arrives here is dropped on the floor.
    taxableValue: ignoredTotal,
    taxRatePercent: ignoredTotal,
    taxAmount: ignoredTotal,
    lineTotal: ignoredTotal,
  })
  .strict();

/**
 * The autosave target. Every field is optional because the vendor's browser
 * PATCHes whatever changed; sending `items` replaces the line set wholesale,
 * exactly as a tender draft replaces its items.
 */
export const quotationDraftSchema = z
  .object({
    deliveryDays: z.number().int().min(0).max(3650).optional(),
    validityDays: z.number().int().min(1).max(365).optional(),
    paymentTerms: z.string().trim().max(500).nullable().optional(),
    freightAmount: moneySchema.optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    items: z.array(quotationItemDraftSchema).min(1).max(50).optional(),

    // Display-only, as above. `freightAmount` is NOT in this list — it is an
    // input the vendor actually chooses, not a figure derived from the lines.
    subtotal: ignoredTotal,
    discountAmount: ignoredTotal,
    taxableAmount: ignoredTotal,
    taxAmount: ignoredTotal,
    grandTotal: ignoredTotal,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.items) return;
    const ids = value.items.map((item) => item.tenderItemId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'A tender line may be quoted only once',
      });
    }
  });

/** Submission carries no body — the stored draft *is* the bid. */
export const submitQuotationSchema = z.object({}).strict().optional().default({});

/**
 * A withdrawal reason is mandatory and long enough to mean something: it goes
 * on the audit trail and the officer reads it.
 */
export const withdrawQuotationSchema = z
  .object({ reason: z.string().trim().min(10).max(500) })
  .strict();

export const quotationQuerySchema = paginationQuerySchema.extend({
  status: z.enum(QUOTATION_STATUSES).optional(),
  tenderId: uuidSchema.optional(),
});

export const tenderIdParamSchema = z.object({ tenderId: uuidSchema }).strict();

export type QuotationItemDraftInput = z.infer<typeof quotationItemDraftSchema>;
export type QuotationDraftInput = z.infer<typeof quotationDraftSchema>;
export type WithdrawQuotationInput = z.infer<typeof withdrawQuotationSchema>;
export type QuotationQuery = z.infer<typeof quotationQuerySchema>;

/* -------------------------------------------------------------------------- */
/* DTOs — three audiences (08 §1)                                             */
/* -------------------------------------------------------------------------- */

export interface QuotationItemDto {
  id: string;
  tenderItemId: string;
  srNo: number | null;
  description: string | null;
  unit: string | null;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxableValue: string;
  taxRatePercent: string;
  taxAmount: string;
  lineTotal: string;
  deliveryDays: number | null;
  brandOrMake: string | null;
  remarks: string | null;
}

/** The vendor's own bid. A vendor always sees their own numbers. */
export interface QuotationVendorDto {
  id: string;
  referenceNumber: string | null;
  tenderId: string;
  tenderTitle: string;
  tenderReferenceNumber: string | null;
  bidSubmissionDeadline: string;
  status: string;
  subtotal: string;
  discountAmount: string;
  taxableAmount: string;
  taxAmount: string;
  freightAmount: string;
  grandTotal: string;
  deliveryDays: number;
  validityDays: number;
  paymentTerms: string | null;
  notes: string | null;
  items: QuotationItemDto[];
  submittedAt: string | null;
  /** The submission receipt: proof of what was sealed, in one line. */
  sealHash: string | null;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
  revisionNumber: number;
  revisionOfId: string | null;
  isLatest: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Everything the buyer may know about a bid **while it is sealed**. */
export interface QuotationSealedDto {
  id: string;
  referenceNumber: string | null;
  status: string;
  vendor: { id: string; companyName: string; rating: string | null };
  submittedAt: string | null;
  itemCount: number;
  sealed: true;
  sealHash: string | null;
}

/** The same bid after `bidOpenedAt`. Only now do amounts exist on this side. */
export interface QuotationOpenedDto extends Omit<QuotationSealedDto, 'sealed' | 'sealHash'> {
  sealed: false;
  sealHash: string | null;
  subtotal: string;
  discountAmount: string;
  taxableAmount: string;
  taxAmount: string;
  freightAmount: string;
  grandTotal: string;
  deliveryDays: number;
  validityDays: number;
  paymentTerms: string | null;
  notes: string | null;
  items: QuotationItemDto[];
  priceScore: string | null;
  technicalScore: string | null;
  totalScore: string | null;
  rank: number | null;
}

export type QuotationBuyerDto = QuotationSealedDto | QuotationOpenedDto;

/** What the officer stares at while waiting. Names and times, never amounts. */
export interface BidSummary {
  invited: number;
  viewed: number;
  declined: number;
  drafts: number;
  submitted: number;
  sealed: boolean;
  bidsOpenAt: string;
  secondsRemaining: number;
  submissions: { vendorName: string; submittedAt: string; sealHash: string | null }[];
}

export interface SealVerification {
  valid: boolean;
  sealHash: string | null;
  computedHash: string;
  submittedAt: string | null;
}
