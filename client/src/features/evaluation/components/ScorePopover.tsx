import { useState } from 'react';
import type { ScoreBreakdownDto } from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';

/**
 * The score breakdown popover (plan 17 §4).
 *
 * `raw 811792.80 → normalised 100.00 × weight 60 = 60.00`, per criterion. A
 * score the officer cannot take apart is a score they will not defend when the
 * award is questioned, so every number on the comparison screen can be opened up
 * to the arithmetic that produced it.
 */
export function ScorePopover({
  score,
  rank,
  breakdown,
  isRecommended,
}: {
  score: string | null;
  rank: number | null;
  breakdown: ScoreBreakdownDto[];
  isRecommended?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const renderRaw = (row: ScoreBreakdownDto) => {
    if (row.raw === null) return 'no data';
    if (row.key === 'price') return formatMoney(row.raw);
    return row.raw;
  };

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex items-baseline gap-1.5 rounded px-1 font-mono tabular-nums',
          rank === 1 ? 'font-semibold text-success' : 'text-text',
        )}
      >
        {score ?? '—'}
        {rank !== null && <span className="text-xs text-muted">#{rank}</span>}
        {isRecommended && <span className="text-xs text-primary">★</span>}
      </button>

      {open && breakdown.length > 0 && (
        <span className="absolute bottom-full left-1/2 z-50 mb-1.5 w-80 -translate-x-1/2 rounded-md border border-border bg-surface p-2 text-left shadow-lg">
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="pb-1 text-left font-medium">Criterion</th>
                <th className="pb-1 text-right font-medium">Raw</th>
                <th className="pb-1 text-right font-medium">Norm.</th>
                <th className="pb-1 text-right font-medium">×w</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <td className="py-0.5">
                    {row.label}
                    {row.manual && <span className="ml-1 text-muted">(manual)</span>}
                  </td>
                  <td className="py-0.5 text-right font-mono tabular-nums text-muted">
                    {renderRaw(row)}
                  </td>
                  <td className="py-0.5 text-right font-mono tabular-nums text-muted">
                    {row.normalised}
                  </td>
                  <td className="py-0.5 text-right font-mono tabular-nums">
                    {row.weighted}
                    <span className="text-muted"> /{row.weight}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="mt-1 block border-t border-border pt-1 text-xs text-muted">
            normalised × weight ÷ 100, summed
          </span>
        </span>
      )}
    </span>
  );
}
