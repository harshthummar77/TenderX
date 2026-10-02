import { z } from 'zod';
import { STATE_BY_CODE, UNITS } from '../constants.js';
import { EVALUATION_METHODS, TENDER_STATUSES } from '../enums.js';
import {
  hsnSchema,
  isoDateTimeSchema,
  moneySchema,
  paginationQuerySchema,
  positiveQuantitySchema,
  uuidSchema,
} from './common.js';

/**
 * Evaluation criteria. Weights are integers summing to exactly 100 — a weight
 * set that sums to 97 silently rescales every bid's score, which is the kind of
 * bug nobody notices until an award is challenged.
 */
export const criterionSchema = z
  .object({
    key: z.string().trim().min(2).max(40).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Key must be alphanumeric'),
    label: z.string().trim().min(2).max(80),
    weight: z.number().int().min(1).max(100),
    direction: z.enum(['lower_is_better', 'higher_is_better']),
  })
  .strict();

export const criteriaSchema = z
  .array(criterionSchema)
  .min(1)
  .max(10)
  .superRefine((criteria, ctx) => {
    const total = criteria.reduce((sum, c) => sum + c.weight, 0);
    if (total !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Criteria weights must sum to exactly 100 (got ${total})`,
      });
    }

    const keys = criteria.map((c) => c.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Criterion keys must be unique' });
    }
    if (!keys.includes('price')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A "price" criterion is required' });
    }
  });

export const tenderItemSchema = z
  .object({
    srNo: z.number().int().min(1).max(50),
    description: z.string().trim().min(3).max(500),
    specifications: z.string().trim().max(2000).optional(),
    hsnCode: hsnSchema.optional(),
    unit: z.enum(UNITS),
    quantity: positiveQuantitySchema,
    taxRatePercent: z
      .string()
      .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Tax rate must be a percentage')
      .default('18.00'),
    /** Internal ceiling — never serialised to a vendor. */
    estimatedUnitPrice: moneySchema.optional(),
  })
  .strict();

const stateCodeSchema = z
  .string()
  .regex(/^\d{2}$/, 'State code must be 2 digits')
  .refine((code) => STATE_BY_CODE.has(code), 'Unknown GST state code');

/** Line numbers must be 1..n with no gaps — they are quoted against by number. */
const assertSequentialItems = (items: { srNo: number }[], ctx: z.RefinementCtx) => {
  const expected = items.map((_item, index) => index + 1);
  const actual = [...items].map((item) => item.srNo).sort((a, b) => a - b);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['items'],
      message: 'Item serial numbers must run 1..n with no gaps or duplicates',
    });
  }
};

/** The deadline is what seals the bids, so it cannot be in the past or after delivery. */
const assertDeadlines = (
  value: { bidSubmissionDeadline: string; deliveryDeadline: string },
  ctx: z.RefinementCtx,
) => {
  const bid = new Date(value.bidSubmissionDeadline).getTime();
  const delivery = new Date(value.deliveryDeadline).getTime();

  if (bid < Date.now() + 60 * 60 * 1000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bidSubmissionDeadline'],
      message: 'Bid deadline must be at least one hour in the future',
    });
  }
  if (bid >= delivery) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryDeadline'],
      message: 'Delivery deadline must be after the bid submission deadline',
    });
  }
};

const tenderBody = {
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().min(10).max(5000),
  categoryId: uuidSchema.optional(),
  estimatedBudget: moneySchema.optional(),
  deliveryLocation: z.string().trim().min(3).max(300),
  deliveryStateCode: stateCodeSchema,
  deliveryDeadline: isoDateTimeSchema,
  bidSubmissionDeadline: isoDateTimeSchema,
  evaluationMethod: z.enum(EVALUATION_METHODS).default('LOWEST_PRICE'),
  criteria: criteriaSchema.optional(),
  termsAndConditions: z.string().trim().max(10_000).optional(),
};

export const createTenderSchema = z
  .object({
    ...tenderBody,
    items: z.array(tenderItemSchema).min(1).max(50),
  })
  .strict()
  .superRefine((value, ctx) => {
    assertSequentialItems(value.items, ctx);
    assertDeadlines(value, ctx);
    if (value.evaluationMethod === 'WEIGHTED_SCORE' && !value.criteria) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message: 'Weighted scoring requires a criteria set',
      });
    }
  });

/**
 * Update replaces the item list wholesale — simpler than diffing, and correct
 * for a draft. Written out field by field rather than mapped from `tenderBody`:
 * a mapped `Object.fromEntries` erases the field types and every consumer ends
 * up with `{}`.
 */
export const updateTenderSchema = z
  .object({
    title: tenderBody.title.optional(),
    description: tenderBody.description.optional(),
    categoryId: uuidSchema.nullable().optional(),
    estimatedBudget: moneySchema.nullable().optional(),
    deliveryLocation: tenderBody.deliveryLocation.optional(),
    deliveryStateCode: stateCodeSchema.optional(),
    deliveryDeadline: isoDateTimeSchema.optional(),
    bidSubmissionDeadline: isoDateTimeSchema.optional(),
    evaluationMethod: z.enum(EVALUATION_METHODS).optional(),
    criteria: criteriaSchema.optional(),
    termsAndConditions: z.string().trim().max(10_000).nullable().optional(),
    items: z.array(tenderItemSchema).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.items) assertSequentialItems(value.items, ctx);
    if (value.bidSubmissionDeadline && value.deliveryDeadline) {
      assertDeadlines(
        { bidSubmissionDeadline: value.bidSubmissionDeadline, deliveryDeadline: value.deliveryDeadline },
        ctx,
      );
    }
  });

export const tenderQuerySchema = paginationQuerySchema.extend({
  status: z.enum(TENDER_STATUSES).optional(),
  categoryId: uuidSchema.optional(),
});

export const inviteVendorsSchema = z
  .object({ vendorIds: z.array(uuidSchema).min(1).max(50) })
  .strict();

export const tenderVendorParamSchema = z
  .object({ id: uuidSchema, vendorId: uuidSchema })
  .strict();

export const declineTenderSchema = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();

export type Criterion = z.infer<typeof criterionSchema>;
export type TenderItemInput = z.infer<typeof tenderItemSchema>;
export type CreateTenderInput = z.infer<typeof createTenderSchema>;
export type UpdateTenderInput = z.infer<typeof updateTenderSchema>;
export type TenderQuery = z.infer<typeof tenderQuerySchema>;

/* -------------------------------------------------------------------------- */
/* DTOs — two audiences (07 §6)                                               */
/* -------------------------------------------------------------------------- */

export interface TenderItemBuyerDto {
  id: string;
  srNo: number;
  description: string;
  specifications: string | null;
  hsnCode: string | null;
  unit: string;
  quantity: string;
  taxRatePercent: string;
  estimatedUnitPrice: string | null;
}

/** Same line, minus the buyer's internal price. */
export type TenderItemVendorDto = Omit<TenderItemBuyerDto, 'estimatedUnitPrice'>;

export interface TenderBuyerDto {
  id: string;
  referenceNumber: string | null;
  title: string;
  description: string;
  category: { id: string; name: string } | null;
  status: string;
  estimatedBudget: string | null;
  deliveryLocation: string;
  deliveryStateCode: string;
  deliveryDeadline: string;
  bidSubmissionDeadline: string;
  bidOpenedAt: string | null;
  evaluationMethod: string;
  criteria: Criterion[];
  termsAndConditions: string | null;
  items: TenderItemBuyerDto[];
  invitationCount: number;
  viewedCount: number;
  quotationCount: number;
  daysRemaining: number | null;
  publishedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
}

export interface TenderVendorDto {
  id: string;
  referenceNumber: string | null;
  title: string;
  description: string;
  category: { id: string; name: string } | null;
  status: string;
  deliveryLocation: string;
  deliveryStateCode: string;
  deliveryDeadline: string;
  bidSubmissionDeadline: string;
  termsAndConditions: string | null;
  items: TenderItemVendorDto[];
  /** Vendors should know how they will be judged — labels and weights only. */
  criteria: { key: string; label: string; weight: number; direction: string }[];
  buyerOrganization: { name: string; city: string; state: string };
  invitationStatus: { invitedAt: string; viewedAt: string | null; respondedAt: string | null } | null;
  myQuotation: { id: string; status: string; submittedAt: string | null } | null;
  daysRemaining: number | null;
}

export interface SuggestedVendor {
  vendorId: string;
  companyName: string;
  score: number;
  rating: number | null;
  isNew: boolean;
  reasons: string[];
}

/** `BidSummary` lives with the sealed-bid module that owns it: schemas/quotation.ts. */
