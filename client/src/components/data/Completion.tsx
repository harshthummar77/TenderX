import { Check, Circle } from 'lucide-react';
import type { CompletionCheck } from '@tb/shared';
import { cn } from '@/lib/cn';

/**
 * Profile completeness, as a meter plus the list of what is missing.
 *
 * A bare "62% complete" is annoying; the list underneath turns it into a to-do.
 * Used by the organization profile (plan 05) and the vendor's own profile
 * (plan 06), both of which gate real capability on being complete.
 */
export function Completion({
  score,
  checks,
  className,
}: {
  score: number;
  checks: CompletionCheck[];
  className?: string;
}) {
  const done = checks.filter((check) => check.done).length;
  const tone =
    score >= 100 ? 'bg-success' : score >= 60 ? 'bg-warning' : 'bg-danger';

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between">
        <p className="text-xs text-muted">
          {done} of {checks.length} complete
        </p>
        <p className="font-mono text-sm font-semibold tabular-nums">{score}%</p>
      </div>

      <div
        role="progressbar"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Profile completeness"
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border"
      >
        <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width: `${score}%` }} />
      </div>

      <ul className="mt-3 space-y-1.5">
        {checks.map((check) => (
          <li key={check.key} className="flex items-start gap-2 text-xs">
            {check.done ? (
              <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
            ) : (
              <Circle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
            )}
            <span className={check.done ? 'text-muted' : 'text-text'}>{check.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The same idea for the vendor KYC list, which reports paths rather than checks. */
export function MissingKycList({
  missing,
  className,
}: {
  missing: { path: string; message: string }[];
  className?: string;
}) {
  if (missing.length === 0) {
    return (
      <p className={cn('flex items-center gap-2 text-xs text-success', className)}>
        <Check aria-hidden className="size-3.5" />
        Everything required is on file.
      </p>
    );
  }

  return (
    <ul className={cn('space-y-1.5', className)}>
      {missing.map((item) => (
        <li key={item.path} className="flex items-start gap-2 text-xs text-text">
          <Circle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          {item.message}
        </li>
      ))}
    </ul>
  );
}
