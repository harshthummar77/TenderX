import { Plus, Trash2 } from 'lucide-react';
import type { Criterion } from '@tb/shared';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

/**
 * Evaluation criteria with weights that always total 100.
 *
 * The server rejects a weight set that sums to anything else (`criteriaSchema`),
 * because a set summing to 97 silently rescales every bid's score — the kind of
 * bug nobody notices until an award is challenged. Rather than surface that as a
 * validation error, this component makes it unreachable: dragging *Price* to 70
 * redistributes the remaining 30 across the others, in proportion to what they
 * already had.
 *
 * Worth the extra hour (plan 17 §3): it prevents `tender.invalid_criteria`
 * entirely, and it looks considered.
 */

/**
 * The keys the scoring engine computes by itself (`AUTOMATIC_CRITERIA` in
 * `scoring.engine.ts`). Anything else is a manual criterion an officer marks
 * 0–10 by hand on the comparison screen.
 */
const AUTOMATIC: { key: string; label: string; direction: Criterion['direction'] }[] = [
  { key: 'price', label: 'Price', direction: 'lower_is_better' },
  { key: 'deliveryDays', label: 'Delivery time', direction: 'lower_is_better' },
  { key: 'vendorRating', label: 'Vendor rating', direction: 'higher_is_better' },
  { key: 'validityDays', label: 'Offer validity', direction: 'higher_is_better' },
];

const MANUAL_SUGGESTIONS: { key: string; label: string }[] = [
  { key: 'technical', label: 'Technical compliance' },
  { key: 'experience', label: 'Relevant experience' },
  { key: 'support', label: 'Support and warranty' },
];

const isAutomatic = (key: string) => AUTOMATIC.some((item) => item.key === key);

/**
 * Set one weight and rebalance the rest to keep the total at exactly 100.
 *
 * Proportional, so the officer's relative judgement between the other criteria
 * survives the change; the rounding remainder lands on the largest of them, which
 * is the one least distorted by a point.
 */
function rebalance(criteria: Criterion[], index: number, weight: number): Criterion[] {
  const clamped = Math.max(1, Math.min(100 - (criteria.length - 1), Math.round(weight)));
  const others = criteria.filter((_criterion, i) => i !== index);
  if (others.length === 0) return [{ ...criteria[index]!, weight: 100 }];

  const remaining = 100 - clamped;
  const othersTotal = others.reduce((sum, criterion) => sum + criterion.weight, 0);

  // Every other criterion keeps at least 1, so no criterion is silently dropped.
  const raw = others.map((criterion) =>
    othersTotal === 0 ? remaining / others.length : (criterion.weight / othersTotal) * remaining,
  );
  const floored = raw.map((value) => Math.max(1, Math.floor(value)));

  let drift = remaining - floored.reduce((sum, value) => sum + value, 0);
  const order = floored
    .map((value, i) => ({ i, value }))
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.i);

  for (let step = 0; drift !== 0 && step < order.length * 100; step += 1) {
    const target = order[step % order.length]!;
    if (drift > 0) {
      floored[target] = (floored[target] ?? 1) + 1;
      drift -= 1;
    } else if ((floored[target] ?? 1) > 1) {
      floored[target] = (floored[target] ?? 1) - 1;
      drift += 1;
    }
  }

  const result = [...criteria];
  result[index] = { ...criteria[index]!, weight: clamped };
  let cursor = 0;
  for (let i = 0; i < result.length; i += 1) {
    if (i === index) continue;
    result[i] = { ...result[i]!, weight: floored[cursor] ?? 1 };
    cursor += 1;
  }
  return result;
}

export function CriteriaEditor({
  criteria,
  onChange,
  error,
  disabled = false,
}: {
  criteria: Criterion[];
  onChange: (criteria: Criterion[]) => void;
  error?: string;
  disabled?: boolean;
}) {
  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const used = new Set(criteria.map((criterion) => criterion.key));

  const setWeight = (index: number, weight: number) => onChange(rebalance(criteria, index, weight));

  const add = (key: string, label: string, direction: Criterion['direction']) => {
    // Added at one point, then rebalanced, so the total never leaves 100.
    const next = [...criteria, { key, label, weight: 1, direction }];
    onChange(rebalance(next, next.length - 1, Math.max(1, Math.floor(100 / next.length))));
  };

  const remove = (index: number) => {
    const next = criteria.filter((_criterion, i) => i !== index);
    if (next.length === 0) return;
    onChange(rebalance(next, 0, next[0]!.weight));
  };

  return (
    <div>
      <div className="space-y-3">
        {criteria.map((criterion, index) => (
          <div key={criterion.key} className="rounded-md border border-border bg-surface p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{criterion.label}</span>
                <Badge tone={isAutomatic(criterion.key) ? 'info' : 'neutral'}>
                  {isAutomatic(criterion.key) ? 'automatic' : 'scored by hand'}
                </Badge>
                {criterion.key === 'price' && <Badge tone="primary">required</Badge>}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <span className="w-12 font-mono text-sm tabular-nums">{criterion.weight}%</span>
                {criterion.key !== 'price' && criteria.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Remove ${criterion.label}`}
                    disabled={disabled}
                    onClick={() => remove(index)}
                  >
                    <Trash2 className="size-3.5 text-danger" />
                  </Button>
                )}
              </div>
            </div>

            <input
              type="range"
              min={1}
              max={100 - (criteria.length - 1)}
              value={criterion.weight}
              disabled={disabled}
              aria-label={`${criterion.label} weight`}
              onChange={(event) => setWeight(index, Number(event.target.value))}
              className="w-full accent-primary"
            />

            <p className="mt-1 text-xs text-muted">
              {criterion.direction === 'lower_is_better' ? 'Lower is better' : 'Higher is better'}
            </p>
          </div>
        ))}
      </div>

      <div
        className={cn(
          'mt-3 flex items-center justify-between rounded-md border px-3 py-2 text-sm',
          total === 100 ? 'border-success/30 bg-success/10' : 'border-danger/30 bg-danger/10',
        )}
      >
        <span className="font-medium">Total weight</span>
        <span className="font-mono tabular-nums">
          {total}% {total === 100 ? '✓' : '— must be exactly 100'}
        </span>
      </div>

      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="mb-2 text-xs text-muted">Add a criterion</p>
        <div className="flex flex-wrap gap-2">
          {AUTOMATIC.filter((item) => !used.has(item.key)).map((item) => (
            <Button
              key={item.key}
              variant="outline"
              size="sm"
              disabled={disabled || criteria.length >= 10}
              leftIcon={<Plus className="size-3" />}
              onClick={() => add(item.key, item.label, item.direction)}
            >
              {item.label}
            </Button>
          ))}

          {MANUAL_SUGGESTIONS.filter((item) => !used.has(item.key)).map((item) => (
            <Button
              key={item.key}
              variant="outline"
              size="sm"
              disabled={disabled || criteria.length >= 10}
              leftIcon={<Plus className="size-3" />}
              onClick={() => add(item.key, item.label, 'higher_is_better')}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          Automatic criteria are computed from the bids. Anything else is marked 0–10 by hand on the
          comparison screen, and an extreme mark costs a sentence.
        </p>
      </div>
    </div>
  );
}

/** The default weighted set: price-dominant, with the two obvious tie-breakers. */
export const defaultCriteria = (): Criterion[] => [
  { key: 'price', label: 'Price', weight: 60, direction: 'lower_is_better' },
  { key: 'deliveryDays', label: 'Delivery time', weight: 20, direction: 'lower_is_better' },
  { key: 'vendorRating', label: 'Vendor rating', weight: 20, direction: 'higher_is_better' },
];
