import { Clock } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { useCountdown, type CountdownSeverity } from '@/hooks/useCountdown';
import { TONE_TEXT, type Tone } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';

const SEVERITY_TONE: Record<CountdownSeverity, Tone> = {
  normal: 'neutral',
  warning: 'warning',
  critical: 'danger',
  expired: 'neutral',
};

/**
 * Live countdown to a deadline (plan 16 §5): amber under 24 h, red under 1 h.
 *
 * On a tender list this is the column a vendor actually reads — "closes in
 * 00:47:12" in red is information no static date can carry. The absolute
 * timestamp stays available in the tooltip, because a countdown alone is useless
 * for planning.
 */
export function Countdown({
  deadline,
  label,
  showIcon = true,
  className,
}: {
  deadline: string | Date | null | undefined;
  /** Prefix such as "Closes" — omitted on a narrow table column. */
  label?: string;
  showIcon?: boolean;
  className?: string;
}) {
  const countdown = useCountdown(deadline);
  const tone = SEVERITY_TONE[countdown.severity];

  return (
    <Tooltip content={deadline ? formatDateTime(deadline) : 'No deadline set'}>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 font-mono text-xs tabular-nums',
          TONE_TEXT[tone],
          countdown.severity === 'critical' && 'font-semibold',
          className,
        )}
      >
        {showIcon && <Clock aria-hidden className="size-3.5" />}
        {label && <span className="font-sans text-muted">{label}</span>}
        {countdown.label}
      </span>
    </Tooltip>
  );
}
