import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Copy, Pencil, ShieldCheck, ShieldX, XCircle } from 'lucide-react';
import { formatDateTime, formatMoney, formatQty } from '@/lib/format';
import { useCountdown } from '@/hooks/useCountdown';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Countdown } from '@/components/Countdown';
import { EmptyState } from '@/components/data/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import {
  useMyQuotation,
  useReviseQuotation,
  useWithdrawQuotation,
} from '@/features/quotations/api';

/**
 * `/vendor/quotations/:id` — a submitted bid, with its seal hash as the receipt.
 *
 * The hash is the vendor's proof of what they sealed and when. After the buyer
 * opens the bids it can be recomputed from the stored rows; if it still matches,
 * nothing was altered in between.
 */
export function QuotationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useQueryTab('offer');
  const quotation = useMyQuotation(id);
  const withdraw = useWithdrawQuotation(id);
  const revise = useReviseQuotation(id);
  const [withdrawing, setWithdrawing] = useState(false);

  const countdown = useCountdown(quotation.data?.bidSubmissionDeadline);

  if (quotation.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!quotation.data) return <EmptyState title="Quotation not found" />;

  const data = quotation.data;
  const biddingOpen = !countdown.expired;
  const canChange = data.status === 'SUBMITTED' && biddingOpen;

  return (
    <>
      <PageHeader
        title={data.tenderTitle}
        status={data.status}
        backTo="/vendor/quotations"
        crumbs={[
          { label: 'My quotations', to: '/vendor/quotations' },
          { label: data.referenceNumber ?? 'Bid' },
        ]}
        meta={
          <>
            <span className="font-mono">{data.referenceNumber || 'Draft'}</span>
            <Link
              to={`/vendor/tenders/${data.tenderId}`}
              className="font-mono text-primary hover:underline"
            >
              {data.tenderReferenceNumber}
            </Link>
            {biddingOpen ? (
              <Countdown deadline={data.bidSubmissionDeadline} label="Closes" />
            ) : (
              <span>Bidding closed</span>
            )}
            {data.revisionNumber > 1 && <span>revision {data.revisionNumber}</span>}
          </>
        }
        actions={
          <>
            {data.status === 'DRAFT' && (
              <Button
                leftIcon={<Pencil className="size-3.5" />}
                onClick={() => navigate(`/vendor/quotations/${data.id}/edit`)}
              >
                Continue editing
              </Button>
            )}

            {canChange && (
              <>
                <Button
                  variant="outline"
                  leftIcon={<XCircle className="size-3.5" />}
                  onClick={() => setWithdrawing(true)}
                >
                  Withdraw
                </Button>
                <Button
                  leftIcon={<Pencil className="size-3.5" />}
                  loading={revise.isPending}
                  onClick={() =>
                    revise.mutate(undefined, {
                      onSuccess: (revision) => {
                        toast.success('Revision opened', 'Your previous bid stays sealed until you submit this one.');
                        navigate(`/vendor/quotations/${revision.id}/edit`);
                      },
                      onError: (error) => toast.fromError(error),
                    })
                  }
                >
                  Revise bid
                </Button>
              </>
            )}
          </>
        }
      />

      {data.withdrawnAt && (
        <Card className="mb-4 border-danger/40 bg-danger/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">Withdrawn {formatDateTime(data.withdrawnAt)}</p>
            <p className="text-xs text-muted">{data.withdrawalReason}</p>
          </CardBody>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="offer">Offer</Tab>
          <Tab value="receipt">Seal receipt</Tab>
          <Tab value="documents">Documents</Tab>
          <Tab value="history">History</Tab>
        </TabList>

        <TabPanel value="offer">
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <Card>
              <CardHeader title="Line items" />
              <Table>
                <THead>
                  <tr>
                    <TH>#</TH>
                    <TH>Description</TH>
                    <TH numeric>Quantity</TH>
                    <TH numeric>Unit price</TH>
                    <TH numeric>Disc %</TH>
                    <TH numeric>GST</TH>
                    <TH numeric>Line total</TH>
                  </tr>
                </THead>
                <TBody>
                  {data.items.map((item) => (
                    <TR key={item.id}>
                      <TD className="font-mono text-xs text-muted">{item.srNo ?? '—'}</TD>
                      <TD>
                        {item.description ?? '—'}
                        {item.brandOrMake && (
                          <span className="block text-xs text-muted">{item.brandOrMake}</span>
                        )}
                      </TD>
                      <TD numeric>{formatQty(item.quantity, item.unit)}</TD>
                      <TD numeric>{formatMoney(item.unitPrice)}</TD>
                      <TD numeric>{item.discountPercent}%</TD>
                      <TD numeric>{item.taxRatePercent}%</TD>
                      <TD numeric>{formatMoney(item.lineTotal)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="Totals" />
                <CardBody>
                  <dl className="space-y-2 text-sm">
                    {(
                      [
                        { label: 'Subtotal', value: data.subtotal },
                        { label: 'Discount', value: data.discountAmount },
                        { label: 'Taxable', value: data.taxableAmount },
                        { label: 'GST', value: data.taxAmount },
                        { label: 'Freight', value: data.freightAmount },
                      ] as const
                    ).map((row) => (
                      <div key={row.label} className="flex justify-between">
                        <dt className="text-muted">{row.label}</dt>
                        <dd className="numeric">{formatMoney(row.value)}</dd>
                      </div>
                    ))}
                    <div className="flex justify-between border-t border-border-strong pt-2 font-semibold">
                      <dt>Grand total</dt>
                      <dd className="numeric">{formatMoney(data.grandTotal)}</dd>
                    </div>
                  </dl>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Terms" />
                <CardBody>
                  <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
                    <Field label="Delivery" numeric>
                      {data.deliveryDays} days
                    </Field>
                    <Field label="Validity" numeric>
                      {data.validityDays} days
                    </Field>
                    <Field label="Payment terms">{data.paymentTerms ?? '—'}</Field>
                    {data.notes && <Field label="Notes">{data.notes}</Field>}
                  </FieldGrid>
                </CardBody>
              </Card>
            </div>
          </div>
        </TabPanel>

        <TabPanel value="receipt">
          <Card className="max-w-2xl">
            <CardHeader
              title="Seal receipt"
              description="Proof of exactly what you submitted, and when."
            />
            <CardBody>
              {data.sealHash ? (
                <>
                  <div className="mb-4 flex items-center gap-2">
                    <ShieldCheck aria-hidden className="size-5 text-success" />
                    <p className="text-sm">
                      Sealed {formatDateTime(data.submittedAt)}
                    </p>
                  </div>

                  <div className="rounded-md border border-border bg-subtle p-3">
                    <p className="text-xs text-muted">SHA-256 of your sealed bid</p>
                    <p className="mt-1 font-mono text-xs break-all select-all">{data.sealHash}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      leftIcon={<Copy className="size-3.5" />}
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(data.sealHash ?? '')
                          .then(() => toast.success('Seal hash copied'))
                          .catch(() =>
                            toast.error('Could not copy', 'Select the text and copy it manually.'),
                          );
                      }}
                    >
                      Copy hash
                    </Button>
                  </div>

                  <p className="mt-3 text-xs text-muted">
                    Keep this. After the buyer opens the bids, they can recompute the hash from the
                    stored rows — a match proves nothing in your bid changed after sealing.
                  </p>
                </>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <ShieldX aria-hidden className="size-5" />
                  This bid has not been submitted yet, so nothing is sealed.
                </div>
              )}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="documents">
          <DocumentsTab
            ownerType="QUOTATION"
            ownerId={id}
            uploadType="QUOTATION_ATTACHMENT"
            canUpload={data.status === 'DRAFT'}
          />
        </TabPanel>

        <TabPanel value="history">
          <HistoryTab entityType="Quotation" entityId={id} />
        </TabPanel>
      </Tabs>

      <ConfirmDialog
        open={withdrawing}
        onClose={() => setWithdrawing(false)}
        title="Withdraw this bid?"
        message="The buyer is told you have withdrawn, and your figures stay sealed. You can submit a new bid while bidding is still open."
        confirmLabel="Withdraw bid"
        requireReason
        reasonMinLength={10}
        loading={withdraw.isPending}
        onConfirm={(reason) =>
          withdraw.mutate(reason, {
            onSuccess: () => {
              toast.success('Bid withdrawn');
              setWithdrawing(false);
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />
    </>
  );
}
