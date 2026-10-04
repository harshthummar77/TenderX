import { Check, Star } from 'lucide-react';
import type { ComparisonDto } from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatMoney, formatQty, humanize } from '@/lib/format';
import { Badge, type Tone } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { ScorePopover } from '@/features/evaluation/components/ScorePopover';

/**
 * The comparison matrix (plan 17 §4) — the centrepiece of the sourcing story.
 *
 * Three details carry it:
 *  - **A green tick on the winning cell per row.** The officer sees instantly
 *    that one vendor is cheapest on the big line even though another wins
 *    overall, which is exactly the judgement the screen exists to support.
 *  - **Sticky first column, horizontally scrollable.** Six bidders must not
 *    break the layout, and the line description has to stay visible while you
 *    scroll to the sixth.
 *  - **"no data" for a new vendor, never 0.0** — a vendor with no history is
 *    unknown, not bad, and plan 09's scoring treats it the same way.
 */

const FLAG_TONE: Record<string, Tone> = {
  lowest_price: 'success',
  best_delivery: 'success',
  highest_price: 'neutral',
  above_budget: 'warning',
  new_vendor: 'info',
  single_bid: 'warning',
  outlier_low: 'danger',
  expired_validity: 'danger',
};

const FLAG_LABEL: Record<string, string> = {
  lowest_price: 'lowest',
  highest_price: 'highest',
  best_delivery: 'fastest',
  above_budget: 'above budget',
  new_vendor: 'new vendor',
  single_bid: 'only bid',
  outlier_low: 'suspiciously low',
  expired_validity: 'validity expired',
};

/** Sticky label column; every data column is a fixed width so the grid stays readable. */
const LABEL_CELL =
  'sticky left-0 z-10 min-w-56 max-w-56 bg-surface px-3 py-2 text-left align-middle';
const HEAD_LABEL_CELL =
  'sticky left-0 z-20 min-w-56 max-w-56 bg-subtle px-3 py-2 text-left align-bottom';

export function ComparisonMatrix({
  comparison,
  recommendedId,
  onRecommend,
  canRecommend,
}: {
  comparison: ComparisonDto;
  recommendedId: string | null;
  onRecommend: (quotationId: string) => void;
  canRecommend: boolean;
}) {
  const { bids, items } = comparison;

  /** The cheapest bid on one tender line — not necessarily the cheapest overall. */
  const lineWinner = (tenderItemId: string) =>
    bids.find((bid) => bid.lines.find((line) => line.tenderItemId === tenderItemId)?.isLowest)
      ?.quotationId ?? null;

  const bestDelivery = Math.min(...bids.map((bid) => bid.deliveryDays));
  const bestRating = Math.max(
    ...bids.map((bid) => (bid.vendor.rating === null ? -1 : Number(bid.vendor.rating))),
  );

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-subtle text-xs text-muted">
          <tr>
            <th className={HEAD_LABEL_CELL}>
              <span className="sr-only">Line</span>
            </th>
            {bids.map((bid) => (
              <th
                key={bid.quotationId}
                className={cn(
                  'min-w-40 px-3 py-2 text-right align-bottom',
                  bid.quotationId === recommendedId && 'bg-primary/10',
                )}
              >
                <span className="block truncate text-sm font-semibold text-text">
                  {bid.vendor.name}
                </span>
                <span className="mt-0.5 flex items-center justify-end gap-1.5">
                  {bid.vendor.rating === null ? (
                    <span className="text-muted">no data</span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5 font-mono tabular-nums">
                      <Star aria-hidden className="size-3 fill-warning text-warning" />
                      {Number(bid.vendor.rating).toFixed(1)}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="divide-y divide-border">
          {items.map((item) => {
            const winner = lineWinner(item.tenderItemId);
            return (
              <tr key={item.tenderItemId}>
                <td className={LABEL_CELL}>
                  <span className="flex gap-2">
                    <span className="font-mono text-xs text-muted">{item.srNo}</span>
                    <span className="min-w-0">
                      <span className="block truncate" title={item.description}>
                        {item.description}
                      </span>
                      <span className="block text-xs text-muted">
                        {formatQty(item.quantity, item.unit)}
                      </span>
                    </span>
                  </span>
                </td>

                {bids.map((bid) => {
                  const line = bid.lines.find((row) => row.tenderItemId === item.tenderItemId);
                  const isWinner = winner === bid.quotationId;
                  return (
                    <td
                      key={bid.quotationId}
                      className={cn(
                        'numeric px-3 py-2',
                        bid.quotationId === recommendedId && 'bg-primary/5',
                      )}
                    >
                      {line ? (
                        <Tooltip
                          content={
                            line.isLowest
                              ? 'Lowest on this line'
                              : `${line.deltaFromLowestPercent}% above the lowest on this line`
                          }
                        >
                          <span className="inline-flex items-center justify-end gap-1">
                            {formatMoney(line.unitPrice)}
                            {isWinner && (
                              <Check aria-hidden className="size-3.5 shrink-0 text-success" />
                            )}
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="text-muted">not quoted</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}

          {/* Totals block */}
          <tr className="border-t-2 border-border-strong bg-subtle/50">
            <td className={cn(LABEL_CELL, 'bg-subtle/50 font-medium')}>Grand total</td>
            {bids.map((bid) => (
              <td
                key={bid.quotationId}
                className={cn(
                  'numeric px-3 py-2 font-semibold',
                  bid.quotationId === recommendedId && 'bg-primary/10',
                )}
              >
                {formatMoney(bid.grandTotal)}
              </td>
            ))}
          </tr>

          <tr>
            <td className={LABEL_CELL}>Delivery</td>
            {bids.map((bid) => (
              <td
                key={bid.quotationId}
                className={cn(
                  'numeric px-3 py-2',
                  bid.quotationId === recommendedId && 'bg-primary/5',
                )}
              >
                <span className="inline-flex items-center justify-end gap-1">
                  {bid.deliveryDays} days
                  {bid.deliveryDays === bestDelivery && (
                    <Check aria-hidden className="size-3.5 text-success" />
                  )}
                </span>
              </td>
            ))}
          </tr>

          <tr>
            <td className={LABEL_CELL}>Vendor rating</td>
            {bids.map((bid) => {
              const rating = bid.vendor.rating === null ? null : Number(bid.vendor.rating);
              return (
                <td
                  key={bid.quotationId}
                  className={cn(
                    'numeric px-3 py-2',
                    bid.quotationId === recommendedId && 'bg-primary/5',
                  )}
                >
                  {rating === null ? (
                    <span className="text-muted">no data</span>
                  ) : (
                    <span className="inline-flex items-center justify-end gap-1">
                      {rating.toFixed(1)}
                      {rating === bestRating && (
                        <Check aria-hidden className="size-3.5 text-success" />
                      )}
                    </span>
                  )}
                </td>
              );
            })}
          </tr>

          <tr className="border-t-2 border-border-strong bg-subtle/50">
            <td className={cn(LABEL_CELL, 'bg-subtle/50 font-medium')}>
              Score
              <span className="block text-xs font-normal text-muted">
                {comparison.tender.criteria.map((c) => c.weight).join('/')}
              </span>
            </td>
            {bids.map((bid) => (
              <td
                key={bid.quotationId}
                className={cn(
                  'px-3 py-2 text-right',
                  bid.quotationId === recommendedId && 'bg-primary/10',
                )}
              >
                <ScorePopover
                  score={bid.totalScore}
                  rank={bid.rank}
                  breakdown={bid.breakdown}
                  isRecommended={bid.quotationId === recommendedId}
                />
              </td>
            ))}
          </tr>

          <tr>
            <td className={LABEL_CELL}>Flags</td>
            {bids.map((bid) => (
              <td
                key={bid.quotationId}
                className={cn('px-3 py-2', bid.quotationId === recommendedId && 'bg-primary/5')}
              >
                <span className="flex flex-wrap justify-end gap-1">
                  {bid.flags.length === 0 && <span className="text-xs text-muted">—</span>}
                  {bid.flags.map((flag) => (
                    <Badge key={flag} tone={FLAG_TONE[flag] ?? 'neutral'}>
                      {FLAG_LABEL[flag] ?? humanize(flag)}
                    </Badge>
                  ))}
                </span>
              </td>
            ))}
          </tr>

          {canRecommend && (
            <tr className="border-t border-border">
              <td className={LABEL_CELL} />
              {bids.map((bid) => (
                <td key={bid.quotationId} className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => onRecommend(bid.quotationId)}
                    className={cn(
                      'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                      bid.quotationId === recommendedId
                        ? 'bg-primary text-on-primary'
                        : 'border border-border hover:bg-subtle',
                    )}
                  >
                    {bid.quotationId === recommendedId ? 'Recommended' : 'Recommend'}
                  </button>
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
