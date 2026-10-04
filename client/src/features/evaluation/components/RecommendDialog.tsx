import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  OVERRIDE_JUSTIFICATION_MIN_LENGTH,
  RECOMMENDATION_MIN_LENGTH,
  type ComparisonBidDto,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { FormField } from '@/components/form/FormField';

/**
 * Nominating a winner (plan 17 §4).
 *
 * The length rule is enforced live rather than left to a 422: picking rank 1
 * costs a sentence (50 characters), and picking anyone else costs a paragraph
 * (100), because overriding the ranking is legitimate — cheapest is not always
 * best — but it has to be argued in writing under the officer's name.
 *
 * Both thresholds are imported from `@tb/shared`, so the counter and the server
 * can never disagree about what "long enough" means.
 */
export function RecommendDialog({
  open,
  onClose,
  bid,
  onConfirm,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  bid: ComparisonBidDto | null;
  onConfirm: (justification: string) => void;
  loading: boolean;
}) {
  const [justification, setJustification] = useState('');

  useEffect(() => {
    if (open) setJustification('');
  }, [open, bid?.quotationId]);

  if (!bid) return null;

  const offRank = bid.rank !== 1;
  const minimum = offRank ? OVERRIDE_JUSTIFICATION_MIN_LENGTH : RECOMMENDATION_MIN_LENGTH;
  const length = justification.trim().length;
  const short = length < minimum;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Recommend ${bid.vendor.name}?`}
      description="This goes to an administrator for approval. You are not awarding the tender yourself."
      size="md"
      dismissable={!loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            loading={loading}
            disabled={short}
            onClick={() => onConfirm(justification.trim())}
          >
            Send recommendation
          </Button>
        </>
      }
    >
      <div className="mb-4 rounded-md border border-border bg-subtle px-3 py-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium">{bid.vendor.name}</span>
          <span className="font-mono tabular-nums">{formatMoney(bid.grandTotal)}</span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between text-xs text-muted">
          <span>
            Rank #{bid.rank} · score {bid.totalScore} · {bid.deliveryDays} days
          </span>
          <span>{bid.referenceNumber}</span>
        </div>
      </div>

      {offRank && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            This bid is ranked #{bid.rank}, not first. Choosing it is allowed, and it needs at least{' '}
            {OVERRIDE_JUSTIFICATION_MIN_LENGTH} characters of justification — the approver will read
            exactly this text.
          </span>
        </div>
      )}

      {bid.deviations.length > 0 && (
        <div className="mb-4">
          <p className="mb-1 text-xs font-medium">Noted deviations</p>
          <ul className="list-inside list-disc text-xs text-muted">
            {bid.deviations.map((deviation) => (
              <li key={deviation}>{deviation}</li>
            ))}
          </ul>
        </div>
      )}

      <FormField label="Justification" required>
        <Textarea
          rows={5}
          value={justification}
          autoFocus
          disabled={loading}
          placeholder={
            offRank
              ? 'Why this vendor rather than the top-ranked bid? Be specific about the technical or commercial reason.'
              : 'Why this bid? One or two sentences is enough.'
          }
          onChange={(event) => setJustification(event.target.value)}
        />
      </FormField>

      <p
        className={cn(
          'mt-1 text-right font-mono text-xs tabular-nums',
          short ? 'text-danger' : 'text-success',
        )}
      >
        {length} / {minimum}
      </p>
    </Dialog>
  );
}
