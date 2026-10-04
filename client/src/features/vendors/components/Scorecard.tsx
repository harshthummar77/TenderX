import type { VendorScorecard } from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatCount, formatDate, formatMoney, formatPercent, formatQty, humanize } from '@/lib/format';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The vendor performance panel (plan 06 §5), used on the buyer's vendor profile
 * and on the vendor's own settings screen.
 *
 * `null` is rendered as "no data", never as zero: a vendor with no delivery
 * history is unknown, not bad, and plan 09's scoring reads it the same way.
 */
function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={cn('mt-0.5 font-mono text-lg tabular-nums', value === null && 'text-muted')}>
        {value ?? 'no data'}
      </p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Scorecard({
  scorecard,
  isLoading,
}: {
  scorecard: VendorScorecard | undefined;
  isLoading: boolean;
}) {
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!scorecard) return null;

  const { orders, value, delivery, quality, invoicing, bidding } = scorecard;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader
          title="Rating"
          description={`Period ${formatDate(scorecard.period.from)} – ${formatDate(scorecard.period.to)}`}
        />
        <CardBody>
          <p
            className={cn(
              'font-mono text-4xl tabular-nums',
              scorecard.rating === null && 'text-2xl text-muted',
            )}
          >
            {scorecard.rating === null ? 'no data' : scorecard.rating.toFixed(1)}
            {scorecard.rating !== null && <span className="text-base text-muted"> / 5</span>}
          </p>

          <ul className="mt-4 space-y-2">
            {scorecard.ratingBreakdown.map((factor) => (
              <li key={factor.factor}>
                <div className="flex items-baseline justify-between text-xs">
                  <span>{humanize(factor.factor)}</span>
                  <span className="font-mono tabular-nums text-muted">
                    {factor.score.toFixed(1)} × {factor.weight}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.min(100, (factor.score / 5) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Delivery and quality" />
        <CardBody className="grid grid-cols-2 gap-4">
          <Metric
            label="On-time rate"
            value={delivery.onTimeRate === null ? null : formatPercent(delivery.onTimeRate, 0)}
            hint={`${formatCount(delivery.onTime)} on time, ${formatCount(delivery.late)} late`}
          />
          <Metric
            label="Average delay"
            value={delivery.avgDelayDays === null ? null : `${delivery.avgDelayDays.toFixed(1)} d`}
          />
          <Metric
            label="Rejection rate"
            value={quality.rejectionRate === null ? null : formatPercent(quality.rejectionRate, 1)}
            hint={`${formatQty(quality.accepted)} accepted of ${formatQty(quality.totalReceived)}`}
          />
          <Metric
            label="Match exceptions"
            value={
              invoicing.exceptionRate === null ? null : formatPercent(invoicing.exceptionRate, 1)
            }
            hint={`${formatCount(invoicing.exceptions)} of ${formatCount(invoicing.submitted)} invoices`}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Orders and value" />
        <CardBody>
          <FieldGrid className="grid-cols-2 sm:grid-cols-2">
            <Field label="Total orders" numeric>
              {formatCount(orders.total)}
            </Field>
            <Field label="Completed" numeric>
              {formatCount(orders.completed)}
            </Field>
            <Field label="In progress" numeric>
              {formatCount(orders.inProgress)}
            </Field>
            <Field label="Cancelled" numeric>
              {formatCount(orders.cancelled)}
            </Field>
            <Field label="Awarded value" numeric>
              {formatMoney(value.awarded)}
            </Field>
            <Field label="Invoiced" numeric>
              {formatMoney(value.invoiced)}
            </Field>
            <Field label="Paid" numeric>
              {formatMoney(value.paid)}
            </Field>
          </FieldGrid>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Bidding" />
        <CardBody className="grid grid-cols-2 gap-4">
          <Metric
            label="Participation"
            value={
              bidding.participationRate === null
                ? null
                : formatPercent(bidding.participationRate, 0)
            }
            hint={`${formatCount(bidding.submitted)} bids from ${formatCount(bidding.invited)} invitations`}
          />
          <Metric
            label="Win rate"
            value={bidding.winRate === null ? null : formatPercent(bidding.winRate, 0)}
            hint={`${formatCount(bidding.won)} won`}
          />
        </CardBody>
      </Card>
    </div>
  );
}
