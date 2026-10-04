import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, Download, RefreshCw, ShieldAlert, X } from 'lucide-react';
import {
  INVOICE_REJECTION_REASON_MIN_LENGTH,
  OVERRIDE_REASON_MIN_LENGTH,
  PERMISSIONS as P,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/data/EmptyState';
import { StatusBadge } from '@/components/data/StatusBadge';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import { MatchChecklist, blockingCheck } from '@/features/invoices/components/MatchChecklist';
import {
  downloadInvoicePdf,
  useApproveInvoice,
  useInvoice,
  useOverrideMatch,
  useRejectInvoice,
  useRematch,
} from '@/features/invoices/api';
import { useFulfilment, usePurchaseOrder } from '@/features/purchaseOrders/api';
import { useGrns } from '@/features/grns/api';

/**
 * `/invoices/:id` — the three-pane verification screen (plan 17 §7), the
 * highest-value screen in the app.
 *
 * Purchase order, goods received and invoice side by side, then the match
 * checklist underneath. The three panes stack vertically below `lg`, because the
 * comparison is what matters, not the columns.
 */
export function InvoiceVerificationPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('verify');
  const [acting, setActing] = useState<'approve' | 'reject' | 'override' | null>(null);

  const invoice = useInvoice('buyer', id);
  const po = usePurchaseOrder('buyer', invoice.data?.purchaseOrderId);
  const fulfilment = useFulfilment(invoice.data?.purchaseOrderId);
  const grns = useGrns(
    { purchaseOrderId: invoice.data?.purchaseOrderId ?? '', limit: 20 },
    !!invoice.data?.purchaseOrderId,
  );

  const approve = useApproveInvoice(id);
  const reject = useRejectInvoice(id);
  const override = useOverrideMatch(id);
  const rematch = useRematch(id);

  if (invoice.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!invoice.data) return <EmptyState title="Invoice not found" />;

  const data = invoice.data;
  const checks = data.matchResult;
  const exception = data.matchStatus === 'EXCEPTION';
  const blocker = blockingCheck(checks);

  const canApprove = can(P.INVOICE_APPROVE);
  // The override button is invisible to an officer, and disabled for an admin
  // when the failure is one the server will never accept an override for.
  const canOverride = can(P.INVOICE_OVERRIDE);
  const decidable = ['SUBMITTED', 'UNDER_REVIEW'].includes(data.status);

  const latestGrn = grns.data?.data?.[0];

  return (
    <>
      <PageHeader
        title={data.referenceNumber}
        status={data.status}
        backTo="/invoices"
        crumbs={[{ label: 'Invoices', to: '/invoices' }, { label: data.referenceNumber }]}
        meta={
          <>
            <span>{data.vendorName}</span>
            <span className="font-mono">{data.vendorInvoiceNumber}</span>
            <span className="font-mono tabular-nums">{formatMoney(data.totalAmount)}</span>
            <span>Due {formatDate(data.dueDate)}</span>
            {data.daysOverdue > 0 && (
              <span className="text-danger">{data.daysOverdue} days overdue</span>
            )}
            <StatusBadge status={data.matchStatus} />
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              leftIcon={<Download className="size-3.5" />}
              onClick={() =>
                void downloadInvoicePdf(data.id, data.referenceNumber).catch((error) =>
                  toast.fromError(error),
                )
              }
            >
              PDF
            </Button>

            {decidable && canApprove && (
              <Button
                variant="outline"
                leftIcon={<RefreshCw className="size-3.5" />}
                loading={rematch.isPending}
                onClick={() =>
                  rematch.mutate(undefined, {
                    onSuccess: () => toast.success('Match re-run'),
                    onError: (error) => toast.fromError(error),
                  })
                }
              >
                Re-run match
              </Button>
            )}

            {decidable && canApprove && (
              <Button
                variant="outline"
                leftIcon={<X className="size-3.5" />}
                onClick={() => setActing('reject')}
              >
                Reject invoice
              </Button>
            )}

            {decidable && exception && canOverride && (
              <Tooltip
                content={
                  blocker
                    ? `"${blocker.label}" cannot be overridden — the goods were not received.`
                    : 'Records an admin override with a written reason. The invoice stays on the exception report permanently.'
                }
              >
                <Button
                  variant="outline"
                  leftIcon={<ShieldAlert className="size-3.5" />}
                  disabled={!!blocker}
                  onClick={() => setActing('override')}
                >
                  Override
                </Button>
              </Tooltip>
            )}

            {decidable && canApprove && (
              <Tooltip
                content={
                  exception
                    ? 'This invoice cannot be approved for payment while the match is an exception.'
                    : undefined
                }
              >
                <Button
                  leftIcon={<Check className="size-3.5" />}
                  disabled={exception}
                  onClick={() => setActing('approve')}
                >
                  Approve for payment
                </Button>
              </Tooltip>
            )}
          </>
        }
      />

      {data.rejectionReason && (
        <Card className="mb-4 border-danger/40 bg-danger/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">Rejected</p>
            <p className="text-xs text-muted">{data.rejectionReason}</p>
          </CardBody>
        </Card>
      )}

      {data.overrideReason && (
        <Card className="mb-4 border-warning/40 bg-warning/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">Match overridden by an administrator</p>
            <p className="text-xs text-muted">{data.overrideReason}</p>
          </CardBody>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="verify">Verification</Tab>
          <Tab value="lines" count={data.items.length}>
            Lines
          </Tab>
          <Tab value="documents">Documents</Tab>
          <Tab value="history">History</Tab>
        </TabList>

        <TabPanel value="verify">
          {/* The three panes. Stacked below lg, side by side above it. */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Purchase order" description={data.poNumber ?? undefined} />
              <CardBody>
                {po.data ? (
                  <>
                    <Link
                      to={`/purchase-orders/${po.data.id}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {po.data.poNumber}
                    </Link>
                    <p className="mt-1 text-sm">{po.data.vendor.name}</p>
                    <p className="text-xs text-muted">
                      {po.data.status.toLowerCase()} · issued {formatDate(po.data.issuedAt)}
                    </p>

                    <ul className="mt-3 space-y-2 border-t border-border pt-3">
                      {po.data.items.slice(0, 5).map((item) => (
                        <li key={item.id} className="text-xs">
                          <p className="truncate">{item.description}</p>
                          <p className="font-mono tabular-nums text-muted">
                            {formatQty(item.quantity, item.unit)} × {formatMoney(item.unitPrice)} ={' '}
                            {formatMoney(item.lineTotal)}
                          </p>
                        </li>
                      ))}
                    </ul>

                    <p className="mt-3 flex justify-between border-t border-border pt-2 text-sm font-medium">
                      <span>Total</span>
                      <span className="numeric">{formatMoney(po.data.totalAmount)}</span>
                    </p>
                  </>
                ) : (
                  <Skeleton className="h-32 w-full" />
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Goods received"
                description={latestGrn ? latestGrn.grnNumber : 'Nothing received yet'}
              />
              <CardBody>
                {fulfilment.data ? (
                  <>
                    {latestGrn && (
                      <p className="text-xs text-muted">
                        received {formatDate(latestGrn.receivedAt)} by{' '}
                        {latestGrn.receivedByName ?? '—'}
                      </p>
                    )}

                    <ul className="mt-3 space-y-2 border-t border-border pt-3">
                      {fulfilment.data.lines.slice(0, 5).map((line) => (
                        <li key={line.purchaseOrderItemId} className="text-xs">
                          <p className="truncate">{line.description}</p>
                          <p className="font-mono tabular-nums text-muted">
                            received {formatQty(line.received)} · accepted{' '}
                            <span className="text-text">{formatQty(line.accepted)}</span>
                            {Number(line.rejected) > 0 && (
                              <span className="text-danger">
                                {' '}
                                · rejected {formatQty(line.rejected)}
                              </span>
                            )}
                          </p>
                        </li>
                      ))}
                    </ul>

                    <p className="mt-3 border-t border-border pt-2 text-xs text-muted">
                      An invoice may only bill what was <strong>accepted</strong>.
                    </p>
                  </>
                ) : (
                  <Skeleton className="h-32 w-full" />
                )}
              </CardBody>
            </Card>

            <Card className={cn(exception && 'border-danger/40')}>
              <CardHeader title="Invoice" description={data.vendorInvoiceNumber} />
              <CardBody>
                <p className="font-mono text-xs">{data.referenceNumber}</p>
                <p className="mt-1 text-xs text-muted">
                  dated {formatDate(data.invoiceDate)} · due {formatDate(data.dueDate)}
                </p>

                <ul className="mt-3 space-y-2 border-t border-border pt-3">
                  {data.items.slice(0, 5).map((item) => (
                    <li key={item.id} className="text-xs">
                      <p className="truncate">{item.description}</p>
                      <p className="font-mono tabular-nums text-muted">
                        {formatQty(item.quantity, item.unit)} × {formatMoney(item.unitPrice)} ={' '}
                        {formatMoney(item.lineTotal)}
                      </p>
                    </li>
                  ))}
                </ul>

                <p className="mt-3 flex justify-between border-t border-border pt-2 text-sm font-medium">
                  <span>Total</span>
                  <span className="numeric">{formatMoney(data.totalAmount)}</span>
                </p>
              </CardBody>
            </Card>
          </div>

          <Card
            className={cn(
              'mt-4',
              exception ? 'border-danger/40' : data.matchStatus === 'MATCHED' && 'border-success/40',
            )}
          >
            <CardHeader
              title="Three-way match"
              description={
                data.matchRunAt ? `Last run ${formatDate(data.matchRunAt)}` : 'Not run yet'
              }
              actions={<StatusBadge status={data.matchStatus} size="md" />}
            />
            <CardBody>
              <MatchChecklist checks={checks} />

              {exception && (
                <div className="mt-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
                  <p className="text-sm font-medium">This invoice cannot be approved for payment.</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {blocker
                      ? `"${blocker.label}" cannot be overridden — the goods were not received. Either the vendor corrects the invoice, or the goods arrive and are receipted.`
                      : 'An administrator can override the exception with a written reason, which is recorded as a security event.'}
                  </p>
                </div>
              )}

              {data.payableBlocker && (
                <p className="mt-3 text-xs text-muted">
                  Payment blocked: {data.payableBlocker}
                </p>
              )}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="lines">
          <Card>
            <CardHeader title="Invoice lines" />
            <Table>
              <THead>
                <tr>
                  <TH>#</TH>
                  <TH>Description</TH>
                  <TH>HSN</TH>
                  <TH numeric>Quantity</TH>
                  <TH numeric>Rate</TH>
                  <TH numeric>Taxable</TH>
                  <TH numeric>Tax</TH>
                  <TH numeric>Line total</TH>
                </tr>
              </THead>
              <TBody>
                {data.items.map((item) => (
                  <TR key={item.id}>
                    <TD className="font-mono text-xs text-muted">{item.srNo ?? '—'}</TD>
                    <TD>{item.description}</TD>
                    <TD>
                      <span className="font-mono text-xs">{item.hsnCode ?? '—'}</span>
                    </TD>
                    <TD numeric>{formatQty(item.quantity, item.unit)}</TD>
                    <TD numeric>{formatMoney(item.unitPrice)}</TD>
                    <TD numeric>{formatMoney(item.taxableValue)}</TD>
                    <TD numeric>
                      {formatMoney(
                        String(
                          Number(item.cgstAmount) + Number(item.sgstAmount) + Number(item.igstAmount),
                        ),
                      )}
                      <span className="block text-xs text-muted">{item.taxRatePercent}%</span>
                    </TD>
                    <TD numeric>{formatMoney(item.lineTotal)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>

            <CardBody className="border-t border-border">
              <FieldGrid className="ml-auto max-w-md grid-cols-2 sm:grid-cols-2">
                <Field label="Taxable" numeric>
                  {formatMoney(data.taxableAmount)}
                </Field>
                <Field label="Tax" numeric>
                  {formatMoney(
                    String(
                      Number(data.cgstAmount) + Number(data.sgstAmount) + Number(data.igstAmount),
                    ),
                  )}
                </Field>
                <Field label="Freight" numeric>
                  {formatMoney(data.freightAmount)}
                </Field>
                <Field label="Total" numeric>
                  {formatMoney(data.totalAmount)}
                </Field>
                <Field label="Paid" numeric>
                  {formatMoney(data.amountPaid)}
                </Field>
                <Field label="Outstanding" numeric>
                  {formatMoney(data.outstanding)}
                </Field>
              </FieldGrid>
              <p className="mt-3 text-right text-xs text-muted italic">
                {data.totalAmountInWords}
              </p>
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="documents">
          <DocumentsTab ownerType="INVOICE" ownerId={id} canUpload={false} />
        </TabPanel>

        <TabPanel value="history">
          <HistoryTab entityType="Invoice" entityId={id} />
        </TabPanel>
      </Tabs>

      <ConfirmDialog
        open={acting === 'approve'}
        onClose={() => setActing(null)}
        title="Approve this invoice for payment?"
        message={
          <>
            {formatMoney(data.totalAmount)} to {data.vendorName}. Above your organization's threshold
            this still needs a second administrator before any money moves.
          </>
        }
        confirmLabel="Approve for payment"
        requireReason={false}
        destructive={false}
        loading={approve.isPending}
        onConfirm={() =>
          approve.mutate(undefined, {
            onSuccess: () => {
              toast.success('Invoice approved for payment');
              setActing(null);
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />

      <ConfirmDialog
        open={acting === 'reject'}
        onClose={() => setActing(null)}
        title="Reject this invoice?"
        message="Tell the vendor exactly what to fix — they resubmit against the same order."
        confirmLabel="Reject invoice"
        requireReason
        reasonMinLength={INVOICE_REJECTION_REASON_MIN_LENGTH}
        loading={reject.isPending}
        onConfirm={(reason) =>
          reject.mutate(reason, {
            onSuccess: () => {
              toast.success('Invoice rejected');
              setActing(null);
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />

      <ConfirmDialog
        open={acting === 'override'}
        onClose={() => setActing(null)}
        title="Override this match exception?"
        message="The invoice becomes payable despite the exception. This is recorded as a security event under your name, and the invoice stays on the exception report permanently."
        confirmLabel="Override exception"
        requireReason
        reasonMinLength={OVERRIDE_REASON_MIN_LENGTH}
        loading={override.isPending}
        onConfirm={(reason) =>
          override.mutate(reason, {
            onSuccess: () => {
              toast.success('Match overridden');
              setActing(null);
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />
    </>
  );
}
