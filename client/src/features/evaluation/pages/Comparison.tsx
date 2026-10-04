import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, Lock, RefreshCw, Unlock } from 'lucide-react';
import { PERMISSIONS as P, type ComparisonBidDto } from '@tb/shared';
import { formatCount, formatMoney, formatPercent, formatQty } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { Countdown } from '@/components/Countdown';
import { EmptyState } from '@/components/data/EmptyState';
import { StatCard, StatCardGrid } from '@/components/data/StatCard';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import { ComparisonMatrix } from '@/features/evaluation/components/ComparisonMatrix';
import { ManualScoring } from '@/features/evaluation/components/ManualScoring';
import { RecommendDialog } from '@/features/evaluation/components/RecommendDialog';
import {
  downloadComparison,
  useComparison,
  useOpenBids,
  useRecalculate,
  useRecommend,
} from '@/features/evaluation/api';
import { useBidSummary, useTender } from '@/features/tenders/api';

/**
 * `/tenders/:id/comparison` — the comparison workspace (plan 17 §4).
 *
 * Before `bidOpenedAt` this route renders the sealed state: vendor names,
 * submission times, seal hashes and a live countdown, and **no amounts at all**.
 * That screen explains sealed bidding better than any paragraph, and it is not a
 * UI choice — the server will not send an amount before the deadline either.
 */
export function ComparisonPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('matrix');

  const tender = useTender(id);
  const sealed = !!tender.data && !tender.data.bidOpenedAt;

  const summary = useBidSummary(id, sealed);
  const comparison = useComparison(sealed ? undefined : id);
  const openBids = useOpenBids(id);
  const recalculate = useRecalculate(id);
  const recommend = useRecommend(id);

  const [recommending, setRecommending] = useState<ComparisonBidDto | null>(null);

  if (!can(P.EVALUATION_RUN)) return <Forbidden />;

  if (tender.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!tender.data) return <EmptyState title="Tender not found" />;

  const header = (
    <PageHeader
      title={tender.data.title}
      status={tender.data.status}
      backTo={`/tenders/${id}`}
      crumbs={[
        { label: 'Tenders', to: '/tenders' },
        { label: tender.data.referenceNumber ?? 'Tender', to: `/tenders/${id}` },
        { label: 'Comparison' },
      ]}
      meta={
        <>
          <span className="font-mono">{tender.data.referenceNumber}</span>
          {tender.data.estimatedBudget && (
            <span className="font-mono tabular-nums">
              Budget {formatMoney(tender.data.estimatedBudget)}
            </span>
          )}
          <span>{formatCount(tender.data.quotationCount)} bids</span>
        </>
      }
      actions={
        !sealed && (
          <>
            <Button
              variant="outline"
              leftIcon={<RefreshCw className="size-3.5" />}
              loading={recalculate.isPending}
              onClick={() =>
                recalculate.mutate(undefined, {
                  onSuccess: () => toast.success('Scores recalculated'),
                  onError: (error) => toast.fromError(error),
                })
              }
            >
              Recalculate
            </Button>
            <Button
              variant="outline"
              leftIcon={<Download className="size-3.5" />}
              onClick={() =>
                void downloadComparison(id as string, tender.data?.referenceNumber ?? 'tender').catch(
                  (error) => toast.fromError(error),
                )
              }
            >
              Export CSV
            </Button>
          </>
        )
      }
    />
  );

  /* ------------------------------- sealed ------------------------------- */

  if (sealed) {
    const data = summary.data;
    return (
      <>
        {header}

        <Card>
          <CardHeader
            title="Bids are sealed"
            description="No amount exists on this side until bidding closes — not for you, and not for anyone else at your organization."
            actions={data && <Countdown deadline={data.bidsOpenAt} label="Opens in" />}
          />
          <CardBody>
            {summary.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <>
                <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
                  {[
                    ['Invited', data?.invited],
                    ['Viewed', data?.viewed],
                    ['Declined', data?.declined],
                    ['Drafting', data?.drafts],
                    ['Submitted', data?.submitted],
                  ].map(([label, value]) => (
                    <div key={label as string}>
                      <p className="text-xs text-muted">{label}</p>
                      <p className="font-mono text-2xl tabular-nums">
                        {formatCount((value as number | undefined) ?? 0)}
                      </p>
                    </div>
                  ))}
                </div>

                {(data?.submissions.length ?? 0) === 0 ? (
                  <EmptyState
                    icon={<Lock className="size-5" />}
                    title="No bids yet"
                    message="Vendor names and submission times appear here as bids arrive."
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
                      {data?.submissions.map((submission) => (
                        <TR key={`${submission.vendorName}-${submission.submittedAt}`}>
                          <TD>{submission.vendorName}</TD>
                          <TD className="text-muted">
                            {new Date(submission.submittedAt).toLocaleString('en-IN')}
                          </TD>
                          <TD>
                            <span className="font-mono text-xs text-muted">
                              {submission.sealHash?.slice(0, 24) ?? '—'}…
                            </span>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}

                {tender.data.status === 'BIDDING_CLOSED' && (
                  <div className="mt-5 flex items-center justify-between rounded-md border border-border bg-subtle px-3 py-2">
                    <p className="text-xs text-muted">
                      Bidding has closed. Opening the bids is recorded on the audit trail with your
                      name, and cannot be undone.
                    </p>
                    <Button
                      leftIcon={<Unlock className="size-3.5" />}
                      loading={openBids.isPending}
                      onClick={() =>
                        openBids.mutate(undefined, {
                          onSuccess: () => toast.success('Bids opened'),
                          onError: (error) => toast.fromError(error),
                        })
                      }
                    >
                      Open bids
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </>
    );
  }

  /* ------------------------------- opened ------------------------------- */

  if (comparison.isLoading) {
    return (
      <>
        {header}
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!comparison.data || comparison.data.bids.length === 0) {
    return (
      <>
        {header}
        <Card>
          <EmptyState
            title="No bids to compare"
            message="Nobody submitted before the deadline. You can cancel this tender or re-issue it."
          />
        </Card>
      </>
    );
  }

  const data = comparison.data;
  const recommendedId = data.tender.recommendedQuotationId;

  return (
    <>
      {header}

      <StatCardGrid>
        <StatCard label="Bids" value={formatCount(data.summary.bidCount)} tone="primary" />
        <StatCard label="Lowest" value={formatMoney(data.summary.lowestTotal)} tone="success" />
        <StatCard label="Highest" value={formatMoney(data.summary.highestTotal)} tone="neutral" />
        <StatCard
          label="Spread"
          value={formatPercent(data.summary.spreadPercent, 1)}
          tone={Number(data.summary.spreadPercent) > 25 ? 'warning' : 'neutral'}
          numeric
        />
      </StatCardGrid>

      {data.summary.budgetVariance && (
        <p className="mt-2 text-xs text-muted">
          Lowest bid is {formatPercent(data.summary.budgetVariance.percent, 1)} (
          {formatMoney(data.summary.budgetVariance.amount)}) against the estimated budget.
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab} className="mt-5">
        <TabList>
          <Tab value="matrix">Matrix</Tab>
          <Tab value="lines">By line item</Tab>
          <Tab value="scores">Scores</Tab>
          <Tab value="documents">Documents</Tab>
        </TabList>

        <TabPanel value="matrix">
          <ComparisonMatrix
            comparison={data}
            recommendedId={recommendedId}
            canRecommend={can(P.EVALUATION_RECOMMEND) && !data.tender.awardedQuotationId}
            onRecommend={(quotationId) =>
              setRecommending(data.bids.find((bid) => bid.quotationId === quotationId) ?? null)
            }
          />

          {data.bids.some((bid) => bid.deviations.length > 0) && (
            <Card className="mt-4">
              <CardHeader
                title="Deviations"
                description="Surfaced, never auto-rejecting. The officer decides."
              />
              <CardBody>
                <ul className="space-y-2">
                  {data.bids
                    .filter((bid) => bid.deviations.length > 0)
                    .map((bid) => (
                      <li key={bid.quotationId} className="text-xs">
                        <span className="font-medium">{bid.vendor.name}</span>
                        <ul className="mt-0.5 list-inside list-disc text-muted">
                          {bid.deviations.map((deviation) => (
                            <li key={deviation}>{deviation}</li>
                          ))}
                        </ul>
                      </li>
                    ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </TabPanel>

        <TabPanel value="lines">
          <Card>
            <CardHeader
              title="Line by line"
              description="The cheapest bid on each line, which is often not the cheapest bid overall."
            />
            <Table>
              <THead>
                <tr>
                  <TH>#</TH>
                  <TH>Description</TH>
                  <TH numeric>Quantity</TH>
                  <TH>Cheapest on this line</TH>
                  <TH numeric>Unit price</TH>
                  <TH numeric>Line total</TH>
                  <TH numeric>Next cheapest</TH>
                </tr>
              </THead>
              <TBody>
                {data.items.map((item) => {
                  const lines = data.bids
                    .map((bid) => ({
                      bid,
                      line: bid.lines.find((row) => row.tenderItemId === item.tenderItemId),
                    }))
                    .filter((entry) => !!entry.line);

                  const winner = lines.find((entry) => entry.line?.isLowest) ?? lines[0];
                  const others = lines
                    .filter((entry) => entry !== winner)
                    .sort(
                      (a, b) =>
                        Number(a.line?.deltaFromLowestPercent ?? 0) -
                        Number(b.line?.deltaFromLowestPercent ?? 0),
                    );

                  return (
                    <TR key={item.tenderItemId}>
                      <TD className="font-mono text-xs text-muted">{item.srNo}</TD>
                      <TD>{item.description}</TD>
                      <TD numeric>{formatQty(item.quantity, item.unit)}</TD>
                      <TD>{winner?.bid.vendor.name ?? '—'}</TD>
                      <TD numeric>{winner?.line ? formatMoney(winner.line.unitPrice) : '—'}</TD>
                      <TD numeric>{winner?.line ? formatMoney(winner.line.lineTotal) : '—'}</TD>
                      <TD numeric>
                        {others[0]?.line
                          ? `+${others[0].line.deltaFromLowestPercent}%`
                          : '—'}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>
        </TabPanel>

        <TabPanel value="scores">
          <ManualScoring comparison={data} tenderId={id as string} />
        </TabPanel>

        <TabPanel value="documents">
          <DocumentsTab ownerType="TENDER" ownerId={id} canUpload={false} />
        </TabPanel>
      </Tabs>

      <RecommendDialog
        open={!!recommending}
        onClose={() => setRecommending(null)}
        bid={recommending}
        loading={recommend.isPending}
        onConfirm={(justification) => {
          if (!recommending) return;
          recommend.mutate(
            { quotationId: recommending.quotationId, justification },
            {
              onSuccess: () => {
                toast.success(
                  'Recommendation sent',
                  'An administrator decides the award — you cannot approve your own recommendation.',
                );
                setRecommending(null);
              },
              onError: (error) => toast.fromError(error),
            },
          );
        }}
      />
    </>
  );
}
