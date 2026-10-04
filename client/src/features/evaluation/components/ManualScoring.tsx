import { useState } from 'react';
import type { ComparisonDto } from '@tb/shared';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/data/EmptyState';
import { useRecalculate, useScoreQuotation } from '@/features/evaluation/api';

/**
 * Manual scoring (plan 09): whole or half marks, 0–10, on the criteria the
 * engine cannot compute for itself.
 *
 * Finer granularity than half marks would be false precision — nobody can tell
 * a 7.3 from a 7.4 on "technical compliance" — and the note field exists because
 * an extreme mark is exactly where evaluation bias hides.
 */
export function ManualScoring({
  comparison,
  tenderId,
}: {
  comparison: ComparisonDto;
  tenderId: string;
}) {
  const manualCriteria = comparison.tender.criteria.filter((criterion) => criterion.manual);
  const score = useScoreQuotation();
  const recalculate = useRecalculate(tenderId);

  const [drafts, setDrafts] = useState<Record<string, Record<string, number>>>(() =>
    Object.fromEntries(
      comparison.bids.map((bid) => [
        bid.quotationId,
        Object.fromEntries(
          bid.breakdown
            .filter((row) => row.manual && row.raw !== null)
            .map((row) => [row.key, Number(row.raw)]),
        ),
      ]),
    ),
  );
  const [notes, setNotes] = useState<Record<string, string>>({});

  if (manualCriteria.length === 0) {
    return (
      <EmptyState
        title="Nothing to score by hand"
        message="Every criterion on this tender is computed from the bids. Add a manual criterion when creating a tender if you want to mark technical compliance."
      />
    );
  }

  const setMark = (quotationId: string, key: string, value: number) =>
    setDrafts((current) => ({
      ...current,
      [quotationId]: { ...(current[quotationId] ?? {}), [key]: value },
    }));

  const save = (quotationId: string) => {
    const scores = drafts[quotationId] ?? {};
    if (Object.keys(scores).length === 0) {
      toast.warning('Give at least one mark before saving');
      return;
    }

    score.mutate(
      { quotationId, scores, note: notes[quotationId]?.trim() || undefined },
      {
        onSuccess: () => {
          toast.success('Scores saved');
          // Marks only count once the ranking is recomputed from them.
          recalculate.mutate(undefined, {
            onError: (error) => toast.fromError(error),
          });
        },
        onError: (error) => toast.fromError(error),
      },
    );
  };

  return (
    <div className="space-y-4">
      {comparison.bids.map((bid) => (
        <Card key={bid.quotationId}>
          <CardHeader
            title={bid.vendor.name}
            description={`Rank #${bid.rank} · score ${bid.totalScore}`}
            actions={
              <Button
                size="sm"
                loading={score.isPending || recalculate.isPending}
                onClick={() => save(bid.quotationId)}
              >
                Save marks
              </Button>
            }
          />
          <CardBody className="space-y-4">
            {manualCriteria.map((criterion) => {
              const value = drafts[bid.quotationId]?.[criterion.key];
              return (
                <div key={criterion.key}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-sm">{criterion.label}</span>
                    <span
                      className={cn(
                        'font-mono text-sm tabular-nums',
                        value === undefined && 'text-muted',
                      )}
                    >
                      {value === undefined ? 'not scored' : value.toFixed(1)}
                      <span className="text-muted"> / 10</span>
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.5}
                    value={value ?? 0}
                    aria-label={`${criterion.label} for ${bid.vendor.name}`}
                    onChange={(event) =>
                      setMark(bid.quotationId, criterion.key, Number(event.target.value))
                    }
                    className="w-full accent-primary"
                  />
                </div>
              );
            })}

            <Textarea
              rows={2}
              placeholder="Note (recommended for a very high or very low mark)"
              value={notes[bid.quotationId] ?? ''}
              onChange={(event) =>
                setNotes((current) => ({ ...current, [bid.quotationId]: event.target.value }))
              }
            />
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
