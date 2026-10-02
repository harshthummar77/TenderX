import type { Quotation, QuotationItem, Tender, TenderItem, Vendor } from '@prisma/client';
import type {
  BidFlag,
  ComparisonBidDto,
  ComparisonDto,
  ComparisonLineDto,
  ComparisonSummaryDto,
  Criterion,
} from '@tb/shared';
import { Decimal, money, qtyToApi, round2, sum, toApi } from '../../lib/money.js';
import { evaluateBids, isManual, type ScorableBid, type ScoredBid } from './scoring.engine.js';

/**
 * The comparison read model (09 §3) — the screen the officer actually decides
 * on. It computes, it does not persist: `recalculate` is what writes scores
 * back. That split means an officer can look at the matrix as often as they
 * like without mutating the evaluation.
 */

export type EligibleBid = Quotation & {
  vendor: Vendor;
  items: QuotationItem[];
};

export type TenderForComparison = Tender & { items: TenderItem[] };

export const criteriaOf = (tender: Tender): Criterion[] =>
  Array.isArray(tender.criteria) ? (tender.criteria as unknown as Criterion[]) : [];

/** `Quotation.criteriaScores` is a Json column; narrow it once, here. */
export const manualScoresOf = (quotation: Quotation): Record<string, number> | null => {
  const raw = quotation.criteriaScores;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, number>;
};

export const toScorableBid = (bid: EligibleBid): ScorableBid => ({
  id: bid.id,
  grandTotal: bid.grandTotal,
  deliveryDays: bid.deliveryDays,
  validityDays: bid.validityDays,
  submittedAt: bid.submittedAt,
  vendorRating: bid.vendor.rating,
  criteriaScores: manualScoresOf(bid),
});

/* -------------------------------------------------------------------------- */
/* Flags and deviations                                                       */
/* -------------------------------------------------------------------------- */

/** More than 30% below the median — a possible costing error, worth a look. */
const OUTLIER_LOW_FRACTION = 0.7;

/** Validity this close to expiry will not survive the approval round trip. */
const VALIDITY_WARNING_DAYS = 7;

const median = (values: Decimal[]): Decimal => {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : round2(sorted[middle - 1]!.plus(sorted[middle]!).div(2));
};

const addDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * 86_400_000);

/**
 * The days a vendor is given to deliver: from the moment bidding closes to the
 * tender's delivery deadline. Comparing a vendor's quoted `deliveryDays`
 * against that is the only honest reading — a bid promising 35 days against a
 * 21-day window is slower than the tender asked for, whatever date it was
 * submitted on.
 */
export const requiredDeliveryDays = (tender: Tender): number =>
  Math.max(
    0,
    Math.ceil(
      (tender.deliveryDeadline.getTime() - tender.bidSubmissionDeadline.getTime()) / 86_400_000,
    ),
  );

function flagsFor(
  bid: EligibleBid,
  context: {
    lowest: Decimal;
    highest: Decimal;
    medianTotal: Decimal;
    bestDelivery: number;
    bidCount: number;
    estimatedBudget: Decimal | null;
    now: Date;
  },
): BidFlag[] {
  const total = money(bid.grandTotal);
  const flags: BidFlag[] = [];

  if (total.equals(context.lowest)) flags.push('lowest_price');
  if (total.equals(context.highest)) flags.push('highest_price');
  if (bid.deliveryDays === context.bestDelivery) flags.push('best_delivery');
  if (context.estimatedBudget && total.greaterThan(context.estimatedBudget)) {
    flags.push('above_budget');
  }
  if (bid.vendor.totalOrders === 0) flags.push('new_vendor');
  if (context.bidCount === 1) flags.push('single_bid');
  if (total.lessThan(context.medianTotal.mul(OUTLIER_LOW_FRACTION))) flags.push('outlier_low');
  if (bid.submittedAt && addDays(bid.submittedAt, bid.validityDays) < context.now) {
    flags.push('expired_validity');
  }

  return flags;
}

/**
 * Where a bid does not meet the tender. **Surfaced, never auto-rejecting** —
 * a bid that is one day slow but half the price may well be the right call, and
 * that call belongs to the officer, not to a validation rule.
 */
function deviationsFor(
  bid: EligibleBid,
  tender: TenderForComparison,
  now: Date,
): string[] {
  const deviations: string[] = [];
  const required = requiredDeliveryDays(tender);

  if (required > 0 && bid.deliveryDays > required) {
    deviations.push(`Delivery ${bid.deliveryDays} days vs ${required} days required`);
  }

  if (bid.submittedAt) {
    const expiresAt = addDays(bid.submittedAt, bid.validityDays);
    const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);
    if (daysLeft <= 0) {
      deviations.push(`Quote validity expired ${Math.abs(daysLeft)} day(s) ago`);
    } else if (daysLeft <= VALIDITY_WARNING_DAYS) {
      deviations.push(`Quote validity expires in ${daysLeft} day(s)`);
    }
  }

  const quotedByItem = new Map(bid.items.map((item) => [item.tenderItemId, item]));
  for (const tenderItem of tender.items) {
    const quoted = quotedByItem.get(tenderItem.id);
    if (!quoted) {
      deviations.push(`Line ${tenderItem.srNo} not quoted`);
      continue;
    }
    if (!money(quoted.quantity).equals(money(tenderItem.quantity))) {
      deviations.push(
        `Line ${tenderItem.srNo} quoted for ${qtyToApi(quoted.quantity)} of ${qtyToApi(tenderItem.quantity)}`,
      );
    }
    if (!tenderItem.hsnCode) {
      deviations.push(`Line ${tenderItem.srNo} has no HSN/SAC code on the tender`);
    }
  }

  return deviations;
}

/* -------------------------------------------------------------------------- */
/* Per-line comparison                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Per-line `isLowest` is what makes the screen worth building: an officer can
 * see at a glance that vendor A is cheapest overall while vendor C is cheapest
 * on the one expensive line — which is the conversation that leads to a split
 * award or a renegotiation.
 */
function linesFor(
  bid: EligibleBid,
  tender: TenderForComparison,
  lowestByItem: Map<string, Decimal>,
): ComparisonLineDto[] {
  const quotedByItem = new Map(bid.items.map((item) => [item.tenderItemId, item]));

  return tender.items
    .map((tenderItem) => {
      const quoted = quotedByItem.get(tenderItem.id);
      if (!quoted) return null;

      const lineTotal = money(quoted.lineTotal);
      const lowest = lowestByItem.get(tenderItem.id) ?? lineTotal;
      const delta = lowest.isZero()
        ? money(0)
        : round2(lineTotal.minus(lowest).div(lowest).mul(100));

      return {
        tenderItemId: tenderItem.id,
        srNo: tenderItem.srNo,
        unitPrice: toApi(quoted.unitPrice),
        lineTotal: toApi(lineTotal),
        isLowest: lineTotal.equals(lowest),
        deltaFromLowestPercent: delta.toFixed(2),
      };
    })
    .filter((line): line is ComparisonLineDto => line !== null);
}

/* -------------------------------------------------------------------------- */
/* The matrix                                                                 */
/* -------------------------------------------------------------------------- */

function summaryOf(bids: EligibleBid[], tender: Tender): ComparisonSummaryDto {
  const totals = bids.map((bid) => money(bid.grandTotal));
  const lowest = totals.reduce((low, v) => (v.lessThan(low) ? v : low), totals[0]!);
  const highest = totals.reduce((high, v) => (v.greaterThan(high) ? v : high), totals[0]!);
  const average = round2(sum(totals).div(totals.length));
  const estimatedBudget = tender.estimatedBudget === null ? null : money(tender.estimatedBudget);

  return {
    bidCount: bids.length,
    lowestTotal: toApi(lowest),
    highestTotal: toApi(highest),
    averageTotal: toApi(average),
    spreadPercent: lowest.isZero()
      ? '0.00'
      : round2(highest.minus(lowest).div(lowest).mul(100)).toFixed(2),
    // Negative is good news: the lowest bid came in under the estimate.
    budgetVariance:
      estimatedBudget === null || estimatedBudget.isZero()
        ? null
        : {
            amount: toApi(lowest.minus(estimatedBudget)),
            percent: round2(lowest.minus(estimatedBudget).div(estimatedBudget).mul(100)).toFixed(2),
          },
  };
}

/** Scores computed off the live rows, so the matrix never shows a stale rank. */
export function scoreEligibleBids(tender: Tender, bids: EligibleBid[]): ScoredBid[] {
  return evaluateBids(bids.map(toScorableBid), tender.evaluationMethod, criteriaOf(tender));
}

export function buildComparison(
  tender: TenderForComparison,
  bids: EligibleBid[],
  now: Date = new Date(),
): ComparisonDto {
  const criteria = criteriaOf(tender).map((criterion) => ({
    key: criterion.key,
    label: criterion.label,
    weight: criterion.weight,
    direction: criterion.direction,
    manual: isManual(criterion.key),
  }));

  const items = tender.items.map((item) => ({
    tenderItemId: item.id,
    srNo: item.srNo,
    description: item.description,
    unit: item.unit,
    quantity: qtyToApi(item.quantity),
  }));

  const tenderDto: ComparisonDto['tender'] = {
    id: tender.id,
    referenceNumber: tender.referenceNumber || null,
    title: tender.title,
    status: tender.status,
    estimatedBudget: tender.estimatedBudget === null ? null : toApi(tender.estimatedBudget),
    evaluationMethod: tender.evaluationMethod,
    criteria,
    bidOpenedAt: tender.bidOpenedAt?.toISOString() ?? null,
    recommendedQuotationId: tender.recommendedQuotationId,
    awardedQuotationId: tender.awardedQuotationId,
  };

  // Nobody bid, or every bid was withdrawn. The screen still has to render.
  if (bids.length === 0) {
    return {
      tender: tenderDto,
      items,
      bids: [],
      summary: {
        bidCount: 0,
        lowestTotal: '0.00',
        highestTotal: '0.00',
        averageTotal: '0.00',
        spreadPercent: '0.00',
        budgetVariance: null,
      },
    };
  }

  const scored = new Map(scoreEligibleBids(tender, bids).map((row) => [row.quotationId, row]));

  const totals = bids.map((bid) => money(bid.grandTotal));
  const context = {
    lowest: totals.reduce((low, v) => (v.lessThan(low) ? v : low), totals[0]!),
    highest: totals.reduce((high, v) => (v.greaterThan(high) ? v : high), totals[0]!),
    medianTotal: median(totals),
    bestDelivery: bids.reduce((best, bid) => Math.min(best, bid.deliveryDays), bids[0]!.deliveryDays),
    bidCount: bids.length,
    estimatedBudget: tender.estimatedBudget === null ? null : money(tender.estimatedBudget),
    now,
  };

  const lowestByItem = new Map<string, Decimal>();
  for (const bid of bids) {
    for (const item of bid.items) {
      const lineTotal = money(item.lineTotal);
      const current = lowestByItem.get(item.tenderItemId);
      if (!current || lineTotal.lessThan(current)) {
        lowestByItem.set(item.tenderItemId, lineTotal);
      }
    }
  }

  const comparisonBids: ComparisonBidDto[] = bids
    .map((bid) => {
      const score = scored.get(bid.id)!;
      return {
        quotationId: bid.id,
        referenceNumber: bid.referenceNumber || null,
        vendor: {
          id: bid.vendor.id,
          name: bid.vendor.companyName,
          rating: bid.vendor.rating === null ? null : bid.vendor.rating.toFixed(2),
          isNew: bid.vendor.totalOrders === 0,
        },
        grandTotal: toApi(bid.grandTotal),
        deliveryDays: bid.deliveryDays,
        validityDays: bid.validityDays,
        submittedAt: bid.submittedAt?.toISOString() ?? null,
        priceScore: score.priceScore === null ? null : score.priceScore.toFixed(2),
        technicalScore: score.technicalScore === null ? null : score.technicalScore.toFixed(2),
        totalScore: score.totalScore.toFixed(2),
        rank: score.rank,
        breakdown: score.breakdown.map((column) => ({
          key: column.key,
          label: column.label,
          weight: column.weight,
          raw: column.raw === null ? null : column.raw.toFixed(2),
          normalised: column.normalised.toFixed(2),
          weighted: column.weighted.toFixed(2),
          manual: column.manual,
        })),
        lines: linesFor(bid, tender, lowestByItem),
        flags: flagsFor(bid, context),
        deviations: deviationsFor(bid, tender, now),
      };
    })
    .sort((a, b) => a.rank - b.rank);

  return { tender: tenderDto, items, bids: comparisonBids, summary: summaryOf(bids, tender) };
}
