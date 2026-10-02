import type { Criterion } from '@tb/shared';
import { Decimal, money, round2, ZERO } from '../../lib/money.js';

/**
 * The scoring engine (09 §2). Pure: no Prisma, no Express, no clock. Every
 * input arrives as an argument, which is why `scoring.spec.ts` can prove the
 * degenerate cases in milliseconds — and those cases are the whole point,
 * because they are where a naive implementation is unfair rather than wrong.
 */

export type Direction = 'lower_is_better' | 'higher_is_better';

/**
 * The four criteria the system computes for itself. Anything else in a tender's
 * criteria set is a manual criterion the officer scores 0–10 by hand.
 */
export const AUTOMATIC_CRITERIA = ['price', 'deliveryDays', 'vendorRating', 'validityDays'] as const;

export type AutomaticCriterionKey = (typeof AUTOMATIC_CRITERIA)[number];

export const isAutomatic = (key: string): key is AutomaticCriterionKey =>
  (AUTOMATIC_CRITERIA as readonly string[]).includes(key);

export const isManual = (key: string): boolean => !isAutomatic(key);

/** Everything the engine needs about one bid, and nothing it does not. */
export interface ScorableBid {
  id: string;
  grandTotal: Decimal.Value;
  deliveryDays: number;
  validityDays: number;
  submittedAt: Date | null;
  vendorRating: Decimal.Value | null;
  /** `{ quality: 8, support: 7 }` — the officer's marks, keyed by criterion. */
  criteriaScores: Record<string, number> | null;
}

/**
 * The raw value of one criterion for one bid, or `null` when it is unknown.
 *
 * `null` is a real answer here, not a failure: a brand-new vendor has no
 * rating, and an unscored manual criterion has no mark yet. What the normaliser
 * does with `null` is the fairness decision below.
 */
export function extract(bid: ScorableBid, criterion: Pick<Criterion, 'key'>): Decimal | null {
  switch (criterion.key) {
    case 'price':
      return money(bid.grandTotal);
    case 'deliveryDays':
      return money(bid.deliveryDays);
    case 'validityDays':
      return money(bid.validityDays);
    case 'vendorRating':
      return bid.vendorRating === null ? null : money(bid.vendorRating);
    default: {
      const mark = bid.criteriaScores?.[criterion.key];
      return mark === undefined || mark === null ? null : money(mark);
    }
  }
}

/** Neutral score for an unknown value. Not zero — see `normalise`. */
export const NEUTRAL_SCORE = 50;

/**
 * Min–max normalisation to 0–100, per criterion, across the eligible bids.
 *
 * Three decisions worth defending, because each one is a fairness choice rather
 * than an arithmetic one:
 *
 * 1. **No data at all → everyone neutral.** If not one bid has a rating, the
 *    criterion cannot discriminate, so it must not pretend to.
 * 2. **`max === min` → everyone gets 100, not 0.** Three vendors quoting the
 *    same delivery time are all meeting the requirement; penalising all three
 *    for agreeing with each other is nonsense, and dividing by `max - min`
 *    would be a division by zero anyway.
 * 3. **`null` → 50, never 0.** A vendor with no rating history is *unproven*,
 *    not bad. Scoring them zero would permanently lock new suppliers out of
 *    every weighted tender — a system that can never onboard anybody new. 50
 *    says the value is unknown, which is the truth.
 */
export function normalise(values: (Decimal | null)[], direction: Direction): Decimal[] {
  const known = values.filter((v): v is Decimal => v !== null);
  if (known.length === 0) return values.map(() => money(NEUTRAL_SCORE));

  const min = known.reduce((lowest, v) => (v.lessThan(lowest) ? v : lowest), known[0]!);
  const max = known.reduce((highest, v) => (v.greaterThan(highest) ? v : highest), known[0]!);

  return values.map((value) => {
    if (value === null) return money(NEUTRAL_SCORE);
    if (max.equals(min)) return money(100);

    const span = max.minus(min);
    const distance = direction === 'lower_is_better' ? max.minus(value) : value.minus(min);
    return distance.div(span).mul(100);
  });
}

export interface ScoreBreakdown {
  key: string;
  label: string;
  weight: number;
  raw: Decimal | null;
  normalised: Decimal;
  weighted: Decimal;
  manual: boolean;
}

export interface ScoredBid {
  quotationId: string;
  breakdown: ScoreBreakdown[];
  /** The normalised price column, 0–100. Null when price is not a criterion. */
  priceScore: Decimal | null;
  /** Everything that is not price, rescaled to 0–100 by its share of the weight. */
  technicalScore: Decimal | null;
  totalScore: Decimal;
  rank: number;
}

/**
 * Ties break by lower `grandTotal`, then earlier `submittedAt`. Both are
 * deterministic, so re-running the scoring never reshuffles equal bids — an
 * officer who refreshes the screen must not see a different rank order.
 */
function compareBids(a: ScorableBid, b: ScorableBid, scores: Map<string, Decimal>): number {
  const byScore = scores.get(b.id)!.comparedTo(scores.get(a.id)!);
  if (byScore !== 0) return byScore;

  const byPrice = money(a.grandTotal).comparedTo(money(b.grandTotal));
  if (byPrice !== 0) return byPrice;

  return (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0);
}

/**
 * Score and rank a bid set against a tender's weighted criteria.
 *
 * Each column's `weighted` figure is rounded before the total sums them, for
 * the same reason the pricing engine rounds per line: a breakdown whose columns
 * do not add up to the total shown beside them is indefensible in front of
 * whoever lost the tender.
 */
export function scoreQuotations(bids: ScorableBid[], criteria: Criterion[]): ScoredBid[] {
  if (bids.length === 0) return [];

  const columns = criteria.map((criterion) => {
    const raws = bids.map((bid) => extract(bid, criterion));
    return { criterion, raws, scores: normalise(raws, criterion.direction as Direction) };
  });

  const technicalWeight = criteria
    .filter((criterion) => criterion.key !== 'price')
    .reduce((total, criterion) => total + criterion.weight, 0);

  const scored = bids.map((bid, index) => {
    const breakdown: ScoreBreakdown[] = columns.map(({ criterion, raws, scores }) => ({
      key: criterion.key,
      label: criterion.label,
      weight: criterion.weight,
      raw: raws[index]!,
      normalised: round2(scores[index]!),
      weighted: round2(scores[index]!.mul(criterion.weight).div(100)),
      manual: isManual(criterion.key),
    }));

    const totalScore = round2(
      breakdown.reduce<Decimal>((total, column) => total.plus(column.weighted), ZERO),
    );

    const priceColumn = breakdown.find((column) => column.key === 'price');
    const technical = breakdown.filter((column) => column.key !== 'price');

    return {
      quotationId: bid.id,
      breakdown,
      priceScore: priceColumn ? priceColumn.normalised : null,
      technicalScore:
        technicalWeight > 0
          ? round2(
              technical
                .reduce<Decimal>((total, column) => total.plus(column.weighted), ZERO)
                .div(technicalWeight)
                .mul(100),
            )
          : null,
      totalScore,
    };
  });

  const byId = new Map(scored.map((row) => [row.quotationId, row.totalScore]));
  const order = [...bids].sort((a, b) => compareBids(a, b, byId));

  return order.map((bid, index) => ({
    ...scored.find((row) => row.quotationId === bid.id)!,
    rank: index + 1,
  }));
}

/**
 * `LOWEST_PRICE`: rank by `grandTotal` ascending, ties by earlier submission.
 *
 * It still produces a full breakdown — a single implicit price column at weight
 * 100 — so the comparison screen, the CSV and the persisted scores have one
 * shape regardless of which method the tender chose. Correct for commodities,
 * and honest about being only about price.
 */
export function rankByLowestPrice(bids: ScorableBid[]): ScoredBid[] {
  const priceCriterion: Criterion = {
    key: 'price',
    label: 'Price',
    weight: 100,
    direction: 'lower_is_better',
  };
  return scoreQuotations(bids, [priceCriterion]);
}

/** Dispatch on the tender's method, so callers never branch themselves. */
export function evaluateBids(
  bids: ScorableBid[],
  method: string,
  criteria: Criterion[],
): ScoredBid[] {
  return method === 'WEIGHTED_SCORE' ? scoreQuotations(bids, criteria) : rankByLowestPrice(bids);
}
