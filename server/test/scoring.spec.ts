import { describe, expect, it } from 'vitest';
import type { Criterion } from '@tb/shared';
import { sum } from '../src/lib/money.js';
import {
  AUTOMATIC_CRITERIA,
  extract,
  isManual,
  normalise,
  rankByLowestPrice,
  scoreQuotations,
  type ScorableBid,
} from '../src/modules/evaluation/scoring.engine.js';
import { money } from '../src/lib/money.js';

/**
 * The scoring engine is pure, so this suite touches neither Postgres nor
 * Express. The degenerate cases are the ones worth the most attention: a naive
 * normaliser is not wrong on them, it is *unfair* on them, which is far harder
 * to notice and far worse to ship.
 */

const bid = (overrides: Partial<ScorableBid> & { id: string }): ScorableBid => ({
  grandTotal: '100000.00',
  deliveryDays: 20,
  validityDays: 45,
  submittedAt: new Date('2025-09-18T10:00:00.000Z'),
  vendorRating: '4.00',
  criteriaScores: null,
  ...overrides,
});

const criterion = (
  key: string,
  weight: number,
  direction: Criterion['direction'] = 'lower_is_better',
): Criterion => ({ key, label: key, weight, direction });

const vals = (...values: (number | null)[]) =>
  values.map((v) => (v === null ? null : money(v)));

describe('normalise', () => {
  it('maps lower_is_better so the cheapest gets 100', () => {
    const scores = normalise(vals(100, 200, 300), 'lower_is_better');
    expect(scores.map((s) => s.toFixed(2))).toEqual(['100.00', '50.00', '0.00']);
  });

  it('maps higher_is_better so the largest gets 100', () => {
    const scores = normalise(vals(100, 200, 300), 'higher_is_better');
    expect(scores.map((s) => s.toFixed(2))).toEqual(['0.00', '50.00', '100.00']);
  });

  /**
   * Three vendors quoting the same delivery time are all meeting the
   * requirement. Penalising all three for agreeing with each other is nonsense
   * — and `(max - v) / (max - min)` would divide by zero anyway.
   */
  it('gives everyone 100 when every value is equal, not 0', () => {
    const scores = normalise(vals(21, 21, 21), 'lower_is_better');
    expect(scores.map((s) => s.toFixed(2))).toEqual(['100.00', '100.00', '100.00']);
  });

  /**
   * A vendor with no rating history is unproven, not bad. Scoring them 0 would
   * permanently lock new suppliers out of every weighted tender.
   */
  it('gives an unknown value 50, never 0', () => {
    const scores = normalise(vals(5, null, 1), 'higher_is_better');
    expect(scores.map((s) => s.toFixed(2))).toEqual(['100.00', '50.00', '0.00']);
  });

  it('gives everyone 50 when nobody has data', () => {
    const scores = normalise(vals(null, null), 'higher_is_better');
    expect(scores.map((s) => s.toFixed(2))).toEqual(['50.00', '50.00']);
  });

  it('handles a single bid', () => {
    expect(normalise(vals(42), 'lower_is_better').map((s) => s.toFixed(2))).toEqual(['100.00']);
  });

  it('ignores nulls when finding the range', () => {
    const scores = normalise(vals(10, null, 20, 30), 'lower_is_better');
    expect(scores[0]!.toFixed(2)).toBe('100.00');
    expect(scores[1]!.toFixed(2)).toBe('50.00');
    expect(scores[3]!.toFixed(2)).toBe('0.00');
  });
});

describe('extract', () => {
  const subject = bid({
    id: 'a',
    grandTotal: '811792.80',
    deliveryDays: 21,
    validityDays: 45,
    vendorRating: '4.20',
    criteriaScores: { quality: 8, support: 0 },
  });

  it('reads the four automatic criteria off the bid', () => {
    expect(extract(subject, { key: 'price' })!.toFixed(2)).toBe('811792.80');
    expect(extract(subject, { key: 'deliveryDays' })!.toFixed(0)).toBe('21');
    expect(extract(subject, { key: 'validityDays' })!.toFixed(0)).toBe('45');
    expect(extract(subject, { key: 'vendorRating' })!.toFixed(2)).toBe('4.20');
  });

  it('reads a manual criterion out of criteriaScores', () => {
    expect(extract(subject, { key: 'quality' })!.toFixed(0)).toBe('8');
  });

  /** A deliberate zero is a score, not a missing value. */
  it('distinguishes a mark of zero from an unscored criterion', () => {
    expect(extract(subject, { key: 'support' })!.toFixed(0)).toBe('0');
    expect(extract(subject, { key: 'technicalCompliance' })).toBeNull();
  });

  it('returns null for an absent vendor rating', () => {
    expect(extract(bid({ id: 'b', vendorRating: null }), { key: 'vendorRating' })).toBeNull();
  });

  it('knows which criteria it computes for itself', () => {
    for (const key of AUTOMATIC_CRITERIA) expect(isManual(key)).toBe(false);
    expect(isManual('quality')).toBe(true);
  });
});

describe('scoreQuotations', () => {
  it('weights the columns and sums them to the total, exactly', () => {
    const bids = [
      bid({ id: 'a', grandTotal: '100000.00', deliveryDays: 10 }),
      bid({ id: 'b', grandTotal: '200000.00', deliveryDays: 20 }),
    ];
    const scored = scoreQuotations(bids, [
      criterion('price', 60),
      criterion('deliveryDays', 40),
    ]);

    const first = scored.find((row) => row.quotationId === 'a')!;
    expect(first.breakdown.map((c) => c.weighted.toFixed(2))).toEqual(['60.00', '40.00']);
    expect(first.totalScore.toFixed(2)).toBe('100.00');

    // The columns must add up to the total shown beside them.
    for (const row of scored) {
      expect(sum(row.breakdown.map((c) => c.weighted)).toFixed(2)).toBe(row.totalScore.toFixed(2));
    }
  });

  /** Plan 09 §11 — identical bids must rank deterministically, not randomly. */
  it('scores three identical bids 100 and ranks them by tie-break', () => {
    const bids = [
      bid({ id: 'later', submittedAt: new Date('2025-09-18T12:00:00.000Z') }),
      bid({ id: 'earlier', submittedAt: new Date('2025-09-18T09:00:00.000Z') }),
      bid({ id: 'middle', submittedAt: new Date('2025-09-18T10:00:00.000Z') }),
    ];
    const scored = scoreQuotations(bids, [criterion('price', 60), criterion('deliveryDays', 40)]);

    for (const row of scored) {
      expect(row.totalScore.toFixed(2)).toBe('100.00');
      for (const column of row.breakdown) expect(column.normalised.toFixed(2)).toBe('100.00');
    }

    // Equal score, equal price -> earliest submission wins.
    expect(scored.map((row) => row.quotationId)).toEqual(['earlier', 'middle', 'later']);
    expect(scored.map((row) => row.rank)).toEqual([1, 2, 3]);
  });

  it('breaks an equal score by the lower grand total', () => {
    const bids = [
      bid({ id: 'dear', grandTotal: '200000.00', criteriaScores: { quality: 10 } }),
      bid({ id: 'cheap', grandTotal: '100000.00', criteriaScores: { quality: 10 } }),
    ];
    // Quality alone decides the score, so both tie at 100 and price breaks it.
    const scored = scoreQuotations(bids, [criterion('quality', 100, 'higher_is_better')]);

    expect(scored.map((row) => row.quotationId)).toEqual(['cheap', 'dear']);
  });

  it('gives a vendor with no rating 50 on that criterion, not 0', () => {
    const bids = [
      bid({ id: 'rated', vendorRating: '5.00' }),
      bid({ id: 'unrated', vendorRating: null }),
      bid({ id: 'poor', vendorRating: '1.00' }),
    ];
    const scored = scoreQuotations(bids, [criterion('vendorRating', 100, 'higher_is_better')]);

    const unrated = scored.find((row) => row.quotationId === 'unrated')!;
    expect(unrated.breakdown[0]!.normalised.toFixed(2)).toBe('50.00');
    expect(unrated.totalScore.toFixed(2)).toBe('50.00');
    // And it beats the genuinely poorly-rated vendor, which is the whole point.
    expect(unrated.rank).toBeLessThan(scored.find((row) => row.quotationId === 'poor')!.rank);
  });

  /**
   * The eligible set is chosen by the caller, so "excluding a bid changes
   * everyone else's score" is a property of normalisation itself. This is that
   * property, proved without a database.
   */
  it('changes every other price score when the cheapest bid leaves the set', () => {
    const all = [
      bid({ id: 'cheap', grandTotal: '100000.00' }),
      bid({ id: 'mid', grandTotal: '150000.00' }),
      bid({ id: 'dear', grandTotal: '200000.00' }),
    ];
    const criteria = [criterion('price', 100)];

    const before = scoreQuotations(all, criteria);
    const after = scoreQuotations(all.slice(1), criteria);

    const midBefore = before.find((row) => row.quotationId === 'mid')!;
    const midAfter = after.find((row) => row.quotationId === 'mid')!;

    expect(midBefore.totalScore.toFixed(2)).toBe('50.00');
    expect(midAfter.totalScore.toFixed(2)).toBe('100.00');
    expect(midAfter.rank).toBe(1);
  });

  it('reports a technical score over everything that is not price', () => {
    const bids = [
      bid({ id: 'a', grandTotal: '100000.00', criteriaScores: { quality: 10, support: 10 } }),
      bid({ id: 'b', grandTotal: '200000.00', criteriaScores: { quality: 0, support: 0 } }),
    ];
    const scored = scoreQuotations(bids, [
      criterion('price', 60),
      criterion('quality', 20, 'higher_is_better'),
      criterion('support', 20, 'higher_is_better'),
    ]);

    const best = scored.find((row) => row.quotationId === 'a')!;
    expect(best.priceScore!.toFixed(2)).toBe('100.00');
    expect(best.technicalScore!.toFixed(2)).toBe('100.00');

    const worst = scored.find((row) => row.quotationId === 'b')!;
    expect(worst.technicalScore!.toFixed(2)).toBe('0.00');
  });

  it('has no technical score when price is the only criterion', () => {
    const scored = scoreQuotations([bid({ id: 'a' })], [criterion('price', 100)]);
    expect(scored[0]!.technicalScore).toBeNull();
  });

  it('marks manual columns as manual', () => {
    const scored = scoreQuotations(
      [bid({ id: 'a', criteriaScores: { quality: 7 } })],
      [criterion('price', 50), criterion('quality', 50, 'higher_is_better')],
    );
    expect(scored[0]!.breakdown.map((c) => c.manual)).toEqual([false, true]);
  });

  it('returns nothing for an empty bid set', () => {
    expect(scoreQuotations([], [criterion('price', 100)])).toEqual([]);
  });
});

describe('rankByLowestPrice', () => {
  it('ranks by grand total ascending with a full price breakdown', () => {
    const scored = rankByLowestPrice([
      bid({ id: 'dear', grandTotal: '300000.00' }),
      bid({ id: 'cheap', grandTotal: '100000.00' }),
      bid({ id: 'mid', grandTotal: '200000.00' }),
    ]);

    expect(scored.map((row) => row.quotationId)).toEqual(['cheap', 'mid', 'dear']);
    expect(scored.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(scored[0]!.totalScore.toFixed(2)).toBe('100.00');
    expect(scored[0]!.breakdown).toHaveLength(1);
    expect(scored[0]!.breakdown[0]!.key).toBe('price');
    expect(scored[0]!.breakdown[0]!.weight).toBe(100);
  });

  it('breaks an identical price by earlier submission', () => {
    const scored = rankByLowestPrice([
      bid({ id: 'later', submittedAt: new Date('2025-09-18T12:00:00.000Z') }),
      bid({ id: 'earlier', submittedAt: new Date('2025-09-18T08:00:00.000Z') }),
    ]);
    expect(scored.map((row) => row.quotationId)).toEqual(['earlier', 'later']);
  });
});
