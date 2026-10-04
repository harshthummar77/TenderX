import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import type { MatchCheckDto } from '@tb/shared';
import { cn } from '@/lib/cn';

/**
 * The three-way match checklist (plan 17 §7).
 *
 * **Failed checks are red and expanded; passed checks are green and collapsed.**
 * The officer reads three lines, not fifteen — which is the difference between a
 * screen that gets used and one that gets skimmed.
 */

/**
 * The checks the server will not let anybody override, mirrored from
 * `NON_OVERRIDABLE_CODES` in `match.engine.ts`. Claiming goods that were never
 * received is the one thing the whole module exists to prevent, so the UI
 * disables the button rather than letting the user discover it as a 422.
 */
export const NON_OVERRIDABLE_CODES = ['quantity', 'vendor_match', 'line_mapping', 'duplicate'];

export const blockingCheck = (checks: MatchCheckDto[] | null | undefined) =>
  (checks ?? []).find(
    (check) => check.status === 'FAIL' && NON_OVERRIDABLE_CODES.includes(check.code),
  ) ?? null;

function CheckRow({ check }: { check: MatchCheckDto }) {
  const failed = check.status === 'FAIL';
  const warned = check.status === 'WARN';
  const [open, setOpen] = useState(failed);

  const hasDetail = !!(check.expected || check.actual || check.variance || check.detail);

  return (
    <li
      className={cn(
        'rounded-md border px-3 py-2',
        failed
          ? 'border-danger/30 bg-danger/5'
          : warned
            ? 'border-warning/30 bg-warning/5'
            : 'border-transparent',
      )}
    >
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-2 text-left"
      >
        {failed ? (
          <X aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
        ) : warned ? (
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        ) : (
          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
        )}

        <span
          className={cn(
            'min-w-0 flex-1 text-sm',
            failed ? 'font-medium text-text' : 'text-muted',
          )}
        >
          {check.label}
        </span>

        {hasDetail &&
          (open ? (
            <ChevronDown aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
          ) : (
            <ChevronRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
          ))}
      </button>

      {open && hasDetail && (
        <dl className="mt-1.5 ml-6 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {check.expected !== undefined && (
            <div>
              <dt className="inline text-muted">expected </dt>
              <dd className="inline font-mono tabular-nums">{check.expected}</dd>
            </div>
          )}
          {check.actual !== undefined && (
            <div>
              <dt className="inline text-muted">invoiced </dt>
              <dd className="inline font-mono tabular-nums">{check.actual}</dd>
            </div>
          )}
          {check.variance !== undefined && (
            <div>
              <dt className="inline text-muted">variance </dt>
              <dd className="inline font-mono tabular-nums text-danger">{check.variance}</dd>
            </div>
          )}
          {check.detail && <p className="w-full text-muted">{check.detail}</p>}
        </dl>
      )}
    </li>
  );
}

export function MatchChecklist({ checks }: { checks: MatchCheckDto[] | null }) {
  if (!checks || checks.length === 0) {
    return (
      <p className="text-sm text-muted">
        The match has not been run yet. It runs automatically when the invoice is submitted.
      </p>
    );
  }

  const failures = checks.filter((check) => check.status === 'FAIL');
  const warnings = checks.filter((check) => check.status === 'WARN');
  const passes = checks.filter((check) => check.status === 'PASS');

  return (
    <ul className="space-y-1">
      {[...failures, ...warnings, ...passes].map((check, index) => (
        <CheckRow key={`${check.code}-${index}`} check={check} />
      ))}
    </ul>
  );
}
