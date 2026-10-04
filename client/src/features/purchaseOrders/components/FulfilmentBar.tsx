import { cn } from '@/lib/cn';
import { formatPercent, humanize } from '@/lib/format';
import { Tooltip } from '@/components/ui/tooltip';

const TONE: Record<string, string> = {
  NOT_STARTED: 'bg-muted',
  PARTIALLY_FULFILLED: 'bg-warning',
  FULFILLED: 'bg-success',
  SHORT_CLOSED: 'bg-info',
};

/**
 * The fulfilment column on the purchase-order list (plan 17 §1): a bar plus the
 * percentage, because "PARTIALLY_FULFILLED" alone does not say whether that
 * means 5% or 95%.
 */
export function FulfilmentBar({
  status,
  percent,
  className,
}: {
  status: string;
  /** `overall.receivedPercent` from the fulfilment DTO, or a plain number. */
  percent: string | number | null | undefined;
  className?: string;
}) {
  const value = percent === null || percent === undefined ? null : Number(percent);
  const clamped = value === null || Number.isNaN(value) ? null : Math.min(100, Math.max(0, value));

  return (
    <Tooltip content={`${humanize(status)}${clamped === null ? '' : ` · ${formatPercent(clamped, 0)} received`}`}>
      <span className={cn('flex min-w-28 items-center gap-2', className)}>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
          <span
            className={cn('block h-full rounded-full', TONE[status] ?? 'bg-muted')}
            style={{ width: `${clamped ?? 0}%` }}
          />
        </span>
        <span className="w-9 shrink-0 font-mono text-xs tabular-nums text-muted">
          {clamped === null ? '—' : `${Math.round(clamped)}%`}
        </span>
      </span>
    </Tooltip>
  );
}
