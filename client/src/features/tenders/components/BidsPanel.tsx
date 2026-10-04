import { Link } from 'react-router-dom';
import { Lock, ShieldCheck } from 'lucide-react';
import type { BidSummary, QuotationBuyerDto } from '@tb/shared';
import { formatCount, formatDateTime, formatMoney, truncate } from '@/lib/format';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { Countdown } from '@/components/Countdown';
import { EmptyState } from '@/components/data/EmptyState';
import { StatusBadge } from '@/components/data/StatusBadge';

/**
 * The bids tab, in both of its states.
 *
 * **Before the deadline it shows no amounts at all** (plan 17 §4) — vendor names,
 * submission times, seal hashes and a countdown, because that is all the server
 * will send while the bids are sealed. It is the clearest explanation of sealed
 * bidding in the product: the officer can see that four vendors have bid and
 * literally cannot see what they bid.
 */
export function BidsPanel({
  tenderId,
  summary,
  quotations,
  isLoading,
  sealed,
  canCompare,
}: {
  tenderId: string;
  summary: BidSummary | undefined;
  quotations: QuotationBuyerDto[] | undefined;
  isLoading: boolean;
  sealed: boolean;
  canCompare: boolean;
}) {
  if (isLoading) return <Skeleton className="h-64 w-full" />;

  if (sealed) {
    return (
      <Card>
        <CardHeader
          title="Bids are sealed"
          description="Nobody — including you — can see an amount until bidding closes."
          actions={
            summary && <Countdown deadline={summary.bidsOpenAt} label="Opens in" />
          }
        />
        <CardBody>
          <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {[
              ['Invited', summary?.invited],
              ['Viewed', summary?.viewed],
              ['Declined', summary?.declined],
              ['Drafting', summary?.drafts],
              ['Submitted', summary?.submitted],
            ].map(([label, value]) => (
              <div key={label as string}>
                <p className="text-xs text-muted">{label}</p>
                <p className="font-mono text-2xl tabular-nums">
                  {formatCount(value as number | undefined ?? 0)}
                </p>
              </div>
            ))}
          </div>

          {(summary?.submissions.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Lock className="size-5" />}
              title="No bids submitted yet"
              message="Submissions appear here as they arrive — names and times only."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Vendor</TH>
                  <TH>Submitted</TH>
                  <TH>Seal hash</TH>
                </tr>
              </THead>
              <TBody>
                {summary?.submissions.map((submission) => (
                  <TR key={`${submission.vendorName}-${submission.submittedAt}`}>
                    <TD>{submission.vendorName}</TD>
                    <TD className="text-muted">{formatDateTime(submission.submittedAt)}</TD>
                    <TD>
                      <Tooltip content="A hash of the sealed bid. After opening, it is recomputed from the stored rows to prove nothing changed.">
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted">
                          <ShieldCheck aria-hidden className="size-3.5" />
                          {submission.sealHash ? truncate(submission.sealHash, 18) : '—'}
                        </span>
                      </Tooltip>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    );
  }

  const rows = quotations ?? [];

  return (
    <Card>
      <CardHeader
        title={`${formatCount(rows.length)} bids`}
        description="Bidding is closed, so amounts are visible."
        actions={
          canCompare &&
          rows.length > 0 && (
            <ButtonLink to={`/tenders/${tenderId}/comparison`} size="sm">
              Open comparison
            </ButtonLink>
          )
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No bids were submitted"
          message="Nobody bid before the deadline. You can cancel the tender, or re-issue it with a later deadline."
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Vendor</TH>
              <TH>Reference</TH>
              <TH>Status</TH>
              <TH numeric>Grand total</TH>
              <TH numeric>Delivery</TH>
              <TH numeric>Score</TH>
              <TH numeric>Rank</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((bid) => {
              const opened = bid.sealed === false ? bid : null;
              return (
                <TR key={bid.id}>
                  <TD>
                    <Link to={`/quotations/${bid.id}`} className="hover:text-primary hover:underline">
                      {bid.vendor.companyName}
                    </Link>
                  </TD>
                  <TD>
                    <span className="font-mono text-xs">{bid.referenceNumber ?? '—'}</span>
                  </TD>
                  <TD>
                    <StatusBadge status={bid.status} />
                  </TD>
                  <TD numeric>{opened ? formatMoney(opened.grandTotal) : '—'}</TD>
                  <TD numeric>{opened ? `${opened.deliveryDays} d` : '—'}</TD>
                  <TD numeric>{opened?.totalScore ?? '—'}</TD>
                  <TD numeric>{opened?.rank ?? '—'}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
