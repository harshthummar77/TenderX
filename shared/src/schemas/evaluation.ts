import { z } from 'zod';
import { APPROVAL_ENTITIES, APPROVAL_STATUSES } from '../enums.js';
import { paginationQuerySchema, uuidSchema } from './common.js';

/**
 * Evaluation, recommendation and approval (plan 09).
 *
 * The length rules in `recommendSchema` are not decoration. Overriding a
 * ranking is legitimate — cheapest is not always best — but it has to be
 * argued in writing, and the argument lands in the audit log under the
 * officer's name. The same reasoning drives `scoreSchema`: an extreme manual
 * score is exactly where evaluation bias hides, so it costs a sentence.
 */

/* -------------------------------------------------------------------------- */
/* Manual scoring                                                             */
/* -------------------------------------------------------------------------- */

/** 0–10, whole or half marks. Finer granularity is false precision. */
const manualScoreSchema = z
  .number()
  .min(0, 'Scores run from 0 to 10')
  .max(10, 'Scores run from 0 to 10')
  .refine((v) => Number.isInteger(v * 2), 'Use whole or half marks');

export const scoreSchema = z
  .object({
    scores: z.record(z.string().min(1).max(40), manualScoreSchema).refine(
      (value) => Object.keys(value).length > 0,
      'Give at least one score',
    ),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Recommendation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 50 characters is roughly one real sentence. The 100-character rule for an
 * off-rank recommendation is enforced in the service, where the rank is known.
 */
export const RECOMMENDATION_MIN_LENGTH = 50;
export const OVERRIDE_JUSTIFICATION_MIN_LENGTH = 100;

export const recommendSchema = z
  .object({
    quotationId: uuidSchema,
    justification: z
      .string()
      .trim()
      .min(RECOMMENDATION_MIN_LENGTH, `Justify the recommendation in at least ${RECOMMENDATION_MIN_LENGTH} characters`)
      .max(5000),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Approval                                                                   */
/* -------------------------------------------------------------------------- */

/** A rejection without a reason is not a decision anybody can act on. */
export const REJECTION_COMMENT_MIN_LENGTH = 20;

export const decideSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    comment: z.string().trim().max(2000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision !== 'REJECTED') return;
    if ((value.comment ?? '').length < REJECTION_COMMENT_MIN_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comment'],
        message: `A rejection needs a reason of at least ${REJECTION_COMMENT_MIN_LENGTH} characters`,
      });
    }
  });

export const approvalQuerySchema = paginationQuerySchema.extend({
  status: z.enum(APPROVAL_STATUSES).optional(),
  entityType: z.enum(APPROVAL_ENTITIES).optional(),
});

export type ScoreInput = z.infer<typeof scoreSchema>;
export type RecommendInput = z.infer<typeof recommendSchema>;
export type DecideInput = z.infer<typeof decideSchema>;
export type ApprovalQuery = z.infer<typeof approvalQuerySchema>;

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

/** One criterion's contribution to one bid's score. */
export interface ScoreBreakdownDto {
  key: string;
  label: string;
  weight: number;
  /** The underlying value — a price, a day count, a rating, a manual mark. */
  raw: string | null;
  /** 0–100 after min–max normalisation across the eligible bids. */
  normalised: string;
  /** `normalised × weight / 100`. These sum to `totalScore`. */
  weighted: string;
  /** Automatic criteria are computed; manual ones are the officer's judgement. */
  manual: boolean;
}

export interface ComparisonLineDto {
  tenderItemId: string;
  srNo: number;
  unitPrice: string;
  lineTotal: string;
  /** Cheapest bid on THIS line, which is often not the cheapest bid overall. */
  isLowest: boolean;
  deltaFromLowestPercent: string;
}

export type BidFlag =
  | 'lowest_price'
  | 'highest_price'
  | 'best_delivery'
  | 'above_budget'
  | 'new_vendor'
  | 'single_bid'
  | 'outlier_low'
  | 'expired_validity';

export interface ComparisonBidDto {
  quotationId: string;
  referenceNumber: string | null;
  vendor: { id: string; name: string; rating: string | null; isNew: boolean };
  grandTotal: string;
  deliveryDays: number;
  validityDays: number;
  submittedAt: string | null;
  priceScore: string | null;
  technicalScore: string | null;
  totalScore: string;
  rank: number;
  breakdown: ScoreBreakdownDto[];
  lines: ComparisonLineDto[];
  flags: BidFlag[];
  /** Surfaced, never auto-rejecting. The officer decides. */
  deviations: string[];
}

export interface ComparisonSummaryDto {
  bidCount: number;
  lowestTotal: string;
  highestTotal: string;
  averageTotal: string;
  /** (highest − lowest) / lowest, as a percentage. */
  spreadPercent: string;
  budgetVariance: { amount: string; percent: string } | null;
}

export interface ComparisonDto {
  tender: {
    id: string;
    referenceNumber: string | null;
    title: string;
    status: string;
    estimatedBudget: string | null;
    evaluationMethod: string;
    criteria: { key: string; label: string; weight: number; direction: string; manual: boolean }[];
    bidOpenedAt: string | null;
    recommendedQuotationId: string | null;
    awardedQuotationId: string | null;
  };
  items: {
    tenderItemId: string;
    srNo: number;
    description: string;
    unit: string;
    quantity: string;
  }[];
  bids: ComparisonBidDto[];
  summary: ComparisonSummaryDto;
}

export interface ApprovalDto {
  id: string;
  entityType: string;
  entityId: string;
  amount: string | null;
  status: string;
  requestedBy: { id: string; name: string; email: string } | null;
  requestedAt: string;
  requestNote: string | null;
  decidedBy: { id: string; name: string; email: string } | null;
  decidedAt: string | null;
  decisionComment: string | null;
  /** True when THIS actor may decide it — the UI uses it to disable the button. */
  canDecide: boolean;
  /** Why not, when `canDecide` is false. */
  blockedReason: string | null;
}

/** The approval plus enough of its subject to decide without a second call. */
export interface ApprovalDetailDto extends ApprovalDto {
  tender: {
    id: string;
    referenceNumber: string | null;
    title: string;
    status: string;
    estimatedBudget: string | null;
    recommendationNote: string | null;
  } | null;
  quotation: {
    id: string;
    referenceNumber: string | null;
    vendorName: string;
    grandTotal: string;
    deliveryDays: number;
    totalScore: string | null;
    rank: number | null;
  } | null;
}
