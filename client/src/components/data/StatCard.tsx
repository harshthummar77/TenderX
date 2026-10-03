import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { TONE_DOT, TONE_TEXT, type Tone } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export interface StatCardProps {
  label: string;
  /** Pre-formatted — the tile does not know whether this is money, a count or a day figure. */
  value: ReactNode;
  icon?: ReactNode;
  /** Severity ring: a tile for three match exceptions should not look like a tile for three POs. */
  tone?: Tone;
  /** Percentage change against the previous window, from the dashboard payload. */
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; label?: string } | null;
  /** When an increase is bad news (overdue invoices, exceptions), green/red flip. */
  invertDelta?: boolean;
  /** Click-through, usually a deep link with filters: `/invoices?matchStatus=EXCEPTION`. */
  to?: string;
  /** Monetary and count values stay mono so a row of tiles lines up. */
  numeric?: boolean;
  loading?: boolean;
}

const DELTA_ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight };

export function StatCard({
  label,
  value,
  icon,
  tone = 'neutral',
  delta,
  invertDelta = false,
  to,
  numeric = true,
  loading = false,
}: StatCardProps) {
  const DeltaIcon = delta ? DELTA_ICON[delta.direction] : null;
  const deltaTone: Tone =
    !delta || delta.direction === 'flat'
      ? 'neutral'
      : (delta.direction === 'up') !== invertDelta
        ? 'success'
        : 'danger';

  const body = (
    <>
      {/* The severity ring: a hairline on the left edge, not a coloured card. */}
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', TONE_DOT[tone])} />

      <div className="flex items-start justify-between gap-3 pl-3">
        <p className="text-xs font-medium text-muted">{label}</p>
        {icon && <span className={cn('shrink-0', TONE_TEXT[tone])}>{icon}</span>}
      </div>

      <div className="mt-2 pl-3">
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <p
            className={cn(
              'truncate text-2xl leading-tight font-semibold text-text',
              numeric && 'font-mono tabular-nums',
            )}
          >
            {value}
          </p>
        )}

        {delta && !loading && (
          <p className={cn('mt-1 flex items-center gap-1 text-xs', TONE_TEXT[deltaTone])}>
            {DeltaIcon && <DeltaIcon aria-hidden className="size-3.5" />}
            <span className="font-mono tabular-nums">{delta.value}</span>
            {delta.label && <span className="text-muted">{delta.label}</span>}
          </p>
        )}
      </div>
    </>
  );

  const shell =
    'relative overflow-hidden rounded-lg border border-border bg-surface p-4 shadow-xs';

  if (!to) return <div className={shell}>{body}</div>;

  return (
    <Link to={to} className={cn(shell, 'block transition-colors hover:border-border-strong hover:bg-subtle')}>
      {body}
    </Link>
  );
}

/** Dashboard tile row. Four across on a laptop, two on a tablet. */
export function StatCardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}
