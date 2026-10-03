import { Badge, type Tone } from '@/components/ui/badge';
import { humanize } from '@/lib/format';

/**
 * Every status in the app, mapped to a colour exactly once (plan 16 §4).
 *
 * One flat map rather than one per enum, deliberately. The values collide only
 * where they should mean the same thing — `REJECTED` is a vendor, a quotation, a
 * PO, an invoice and an approval, and it is red in all five — so `AWARDED` cannot
 * end up a different green on the comparison screen than on the tender list.
 *
 * The palette is semantic, from §4:
 *   success — approved, paid, matched, delivered
 *   warning — pending, partial, under review, overridden
 *   danger  — rejected, exception, failed, blacklisted
 *   info    — draft, informational
 *   primary — the active working state (published, submitted, issued)
 *   neutral — terminal-but-fine (closed, cancelled, lost, withdrawn)
 */
export const STATUS_TONES: Record<string, Tone> = {
  // identity
  INVITED: 'info',
  ACTIVE: 'success',
  SUSPENDED: 'danger',
  BLACKLISTED: 'danger',

  // approvals, shared by organization / vendor / tender / invoice / payment
  PENDING_APPROVAL: 'warning',
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',

  // tender
  DRAFT: 'info',
  PUBLISHED: 'primary',
  BIDDING_CLOSED: 'neutral',
  UNDER_EVALUATION: 'warning',
  AWARDED: 'success',
  CANCELLED: 'neutral',
  CLOSED: 'neutral',

  // quotation
  SUBMITTED: 'primary',
  WITHDRAWN: 'neutral',
  SHORTLISTED: 'info',
  LOST: 'neutral',

  // purchase order
  ISSUED: 'primary',
  ACCEPTED: 'success',

  // fulfilment
  NOT_STARTED: 'neutral',
  PARTIALLY_FULFILLED: 'warning',
  FULFILLED: 'success',
  SHORT_CLOSED: 'neutral',

  // delivery & GRN
  DISPATCHED: 'primary',
  IN_TRANSIT: 'info',
  DELIVERED: 'success',
  PARTIALLY_ACCEPTED: 'warning',

  // invoice
  UNDER_REVIEW: 'warning',
  APPROVED_FOR_PAYMENT: 'success',
  PARTIALLY_PAID: 'warning',
  PAID: 'success',

  // three-way match
  NOT_RUN: 'neutral',
  MATCHED: 'success',
  EXCEPTION: 'danger',
  OVERRIDDEN: 'warning',

  // payment
  COMPLETED: 'success',
  FAILED: 'danger',
};

export const statusTone = (status: string | null | undefined): Tone =>
  (status && STATUS_TONES[status]) || 'neutral';

export function StatusBadge({
  status,
  tone,
  dot = true,
  size = 'sm',
  className,
}: {
  status: string | null | undefined;
  /** Override only for something that is not an enum value, e.g. "Overdue". */
  tone?: Tone;
  dot?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  if (!status) return <span className="text-muted">—</span>;

  return (
    <Badge tone={tone ?? statusTone(status)} dot={dot} size={size} className={className}>
      {humanize(status)}
    </Badge>
  );
}
