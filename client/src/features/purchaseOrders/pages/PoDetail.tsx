import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, Check, Download, PackageCheck, Receipt, Send, Truck, X } from 'lucide-react';
import {
  PERMISSIONS as P,
  PO_REJECTION_REASON_MIN_LENGTH,
  SHORT_CLOSE_REASON_MIN_LENGTH,
} from '@tb/shared';
import { formatDate, formatDateTime, formatMoney, formatQty } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/data/EmptyState';
import { StatusBadge } from '@/components/data/StatusBadge';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import { FulfilmentBar } from '@/features/purchaseOrders/components/FulfilmentBar';
import { PoSummary } from '@/features/purchaseOrders/components/PoSummary';
import {
  downloadPoPdf,
  useAcceptPo,
  useCancelPo,
  useFulfilment,
  useIssuePo,
  usePurchaseOrder,
  useRejectPo,
  useShortClose,
  type PoScope,
} from '@/features/purchaseOrders/api';
import { useGrns } from '@/features/grns/api';
import { useInvoices } from '@/features/invoices/api';
import { useMyDeliveries } from '@/features/deliveries/api';

type Confirming = 'cancel' | 'accept' | 'reject' | 'shortClose' | null;

function PoDetail({ scope }: { scope: PoScope }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('order');
  const [confirming, setConfirming] = useState<Confirming>(null);

  const po = usePurchaseOrder(scope, id);
  const isBuyer = scope === 'buyer';

  const fulfilment = useFulfilment(isBuyer ? id : undefined);
  // Each tab's list is scoped to this order, and only fetched for the side that
  // has the endpoint: a vendor has no `/grns`, a buyer no `/vendor/deliveries`.
  const grns = useGrns({ purchaseOrderId: id ?? '', limit: 50 }, isBuyer && !!id);
  const invoices = useInvoices(scope, { purchaseOrderId: id ?? '', limit: 50 }, !!id);
  const deliveries = useMyDeliveries({ purchaseOrderId: id ?? '', limit: 50 }, !isBuyer && !!id);

  const issue = useIssuePo();
  const cancel = useCancelPo();
  const accept = useAcceptPo();
  const reject = useRejectPo();
  const shortClose = useShortClose();

  if (po.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!po.data) return <EmptyState title="Purchase order not found" />;

  const data = po.data;
  const listPath = isBuyer ? '/purchase-orders' : '/vendor/purchase-orders';

  return (
    <>
      <PageHeader
        title={data.poNumber}
        status={data.status}
        backTo={listPath}
        crumbs={[
          { label: isBuyer ? 'Orders' : 'My orders', to: listPath },
          { label: data.poNumber },
        ]}
        meta={
          <>
            <span>{isBuyer ? data.vendor.name : data.buyer.name}</span>
            <span className="font-mono tabular-nums">{formatMoney(data.totalAmount)}</span>
            <span>Expected {formatDate(data.expectedDeliveryDate)}</span>
            <FulfilmentBar
              status={data.fulfilmentStatus}
              percent={fulfilment.data?.overall.receivedPercent}
              className="max-w-40"
            />
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              leftIcon={<Download className="size-3.5" />}
              onClick={() =>
                void downloadPoPdf(data.id, data.poNumber).catch((error) => toast.fromError(error))
              }
            >
              PDF
            </Button>

            {isBuyer && data.status === 'DRAFT' && can(P.PO_ISSUE) && (
              <Button
                leftIcon={<Send className="size-3.5" />}
                loading={issue.isPending}
                onClick={() =>
                  issue.mutate(
                    { id: data.id },
                    {
                      onSuccess: () => toast.success('Purchase order issued'),
                      onError: (error) => toast.fromError(error),
                    },
                  )
                }
              >
                Issue order
              </Button>
            )}

            {isBuyer && data.status === 'ACCEPTED' && can(P.GRN_CREATE) && (
              <ButtonLink
                to={`/purchase-orders/${data.id}/receive`}
                leftIcon={<PackageCheck className="size-3.5" />}
              >
                Receive goods
              </ButtonLink>
            )}

            {isBuyer &&
              data.status === 'ACCEPTED' &&
              data.fulfilmentStatus === 'PARTIALLY_FULFILLED' &&
              can(P.PO_CANCEL) && (
                <Button variant="outline" onClick={() => setConfirming('shortClose')}>
                  Short-close
                </Button>
              )}

            {isBuyer && ['ISSUED', 'ACCEPTED'].includes(data.status) && can(P.PO_CANCEL) && (
              <Button
                variant="outline"
                leftIcon={<Ban className="size-3.5" />}
                onClick={() => setConfirming('cancel')}
              >
                Cancel
              </Button>
            )}

            {!isBuyer && data.status === 'ISSUED' && can(P.PO_RESPOND) && (
              <>
                <Button
                  variant="outline"
                  leftIcon={<X className="size-3.5" />}
                  onClick={() => setConfirming('reject')}
                >
                  Reject
                </Button>
                <Button
                  leftIcon={<Check className="size-3.5" />}
                  onClick={() => setConfirming('accept')}
                >
                  Accept order
                </Button>
              </>
            )}

            {!isBuyer && data.status === 'ACCEPTED' && can(P.DELIVERY_CREATE) && (
              <ButtonLink
                to={`/vendor/purchase-orders/${data.id}/dispatch`}
                leftIcon={<Truck className="size-3.5" />}
              >
                Dispatch goods
              </ButtonLink>
            )}

            {!isBuyer && data.status === 'ACCEPTED' && can(P.INVOICE_SUBMIT) && (
              <ButtonLink
                to={`/vendor/invoices/new?poId=${data.id}`}
                variant="outline"
                leftIcon={<Receipt className="size-3.5" />}
              >
                Raise invoice
              </ButtonLink>
            )}
          </>
        }
      />

      {data.awaitingResponse && data.status === 'ISSUED' && (
        <Card className="mb-4 border-warning/40 bg-warning/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">
              {isBuyer ? 'The vendor has not responded yet' : 'This order is waiting on you'}
            </p>
            <p className="text-xs text-muted">
              {isBuyer
                ? 'It is past the agreed response window. The order is not cancelled automatically — that is your call.'
                : 'Accepting is accepting the contract. If something is wrong, reject it with a reason and the buyer can amend it.'}
            </p>
          </CardBody>
        </Card>
      )}

      {data.rejectionReason && (
        <Card className="mb-4 border-danger/40 bg-danger/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">Rejected {formatDate(data.rejectedAt)}</p>
            <p className="text-xs text-muted">{data.rejectionReason}</p>
          </CardBody>
        </Card>
      )}

      {data.cancellationReason && (
        <Card className="mb-4 border-danger/40 bg-danger/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">Cancelled {formatDate(data.cancelledAt)}</p>
            <p className="text-xs text-muted">{data.cancellationReason}</p>
          </CardBody>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="order">Order</Tab>
          {isBuyer && <Tab value="fulfilment">Fulfilment</Tab>}
          {isBuyer && <Tab value="grns">Goods receipts</Tab>}
          {!isBuyer && <Tab value="deliveries">Deliveries</Tab>}
          <Tab value="invoices">Invoices</Tab>
          <Tab value="documents">Documents</Tab>
          <Tab value="history">History</Tab>
        </TabList>

        <TabPanel value="order">
          <PoSummary po={data} />
        </TabPanel>

        {isBuyer && (
          <TabPanel value="fulfilment">
            <Card>
              <CardHeader
                title="Line by line"
                description="Pending delivery is what plan 11 still expects; pending invoice is what the vendor may bill."
              />
              {fulfilment.isLoading ? (
                <CardBody>
                  <Skeleton className="h-32 w-full" />
                </CardBody>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>#</TH>
                      <TH>Description</TH>
                      <TH numeric>Ordered</TH>
                      <TH numeric>Received</TH>
                      <TH numeric>Accepted</TH>
                      <TH numeric>Rejected</TH>
                      <TH numeric>Invoiced</TH>
                      <TH>Status</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {(fulfilment.data?.lines ?? []).map((line) => (
                      <TR key={line.purchaseOrderItemId}>
                        <TD className="font-mono text-xs text-muted">{line.srNo}</TD>
                        <TD>{line.description}</TD>
                        <TD numeric>{formatQty(line.ordered, line.unit)}</TD>
                        <TD numeric>{formatQty(line.received)}</TD>
                        <TD numeric>{formatQty(line.accepted)}</TD>
                        <TD numeric className={Number(line.rejected) > 0 ? 'text-danger' : undefined}>
                          {formatQty(line.rejected)}
                        </TD>
                        <TD numeric>{formatQty(line.invoiced)}</TD>
                        <TD>
                          <StatusBadge
                            status={line.status}
                            tone={
                              line.status === 'COMPLETE'
                                ? 'success'
                                : line.status === 'OVER_RECEIVED'
                                  ? 'danger'
                                  : line.status === 'PARTIAL'
                                    ? 'warning'
                                    : 'neutral'
                            }
                          />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          </TabPanel>
        )}

        {isBuyer && (
          <TabPanel value="grns">
            <Card>
              <CardHeader title="Goods receipts" />
              {(grns.data?.data ?? []).length === 0 ? (
                <EmptyState
                  icon={<PackageCheck className="size-5" />}
                  title="Nothing received yet"
                  message="Record a goods receipt when a delivery arrives."
                  action={
                    data.status === 'ACCEPTED' && can(P.GRN_CREATE) ? (
                      <ButtonLink to={`/purchase-orders/${data.id}/receive`} size="sm">
                        Receive goods
                      </ButtonLink>
                    ) : undefined
                  }
                />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>GRN</TH>
                      <TH>Challan</TH>
                      <TH>Received</TH>
                      <TH>By</TH>
                      <TH>Status</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {(grns.data?.data ?? []).map((grn) => (
                      <TR key={grn.id} clickable onClick={() => navigate(`/grns/${grn.id}`)}>
                        <TD>
                          <span className="font-mono text-xs">{grn.grnNumber}</span>
                        </TD>
                        <TD>{grn.challanNumber ?? '—'}</TD>
                        <TD className="text-muted">{formatDateTime(grn.receivedAt)}</TD>
                        <TD className="text-muted">{grn.receivedByName ?? '—'}</TD>
                        <TD>
                          <StatusBadge status={grn.status} />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          </TabPanel>
        )}

        {!isBuyer && (
          <TabPanel value="deliveries">
            <Card>
              <CardHeader title="Deliveries" />
              {(deliveries.data?.data ?? []).length === 0 ? (
                <EmptyState
                  icon={<Truck className="size-5" />}
                  title="Nothing dispatched yet"
                  message="Create a delivery when goods leave your warehouse."
                  action={
                    data.status === 'ACCEPTED' && can(P.DELIVERY_CREATE) ? (
                      <ButtonLink to={`/vendor/purchase-orders/${data.id}/dispatch`} size="sm">
                        Dispatch goods
                      </ButtonLink>
                    ) : undefined
                  }
                />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>Challan</TH>
                      <TH>Dispatched</TH>
                      <TH>Carrier</TH>
                      <TH>Tracking</TH>
                      <TH>Status</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {(deliveries.data?.data ?? []).map((delivery) => (
                      <TR key={delivery.id}>
                        <TD>
                          <span className="font-mono text-xs">{delivery.challanNumber}</span>
                        </TD>
                        <TD className="text-muted">{formatDateTime(delivery.dispatchedAt)}</TD>
                        <TD>{delivery.carrierName ?? '—'}</TD>
                        <TD>
                          <span className="font-mono text-xs">
                            {delivery.trackingReference ?? '—'}
                          </span>
                        </TD>
                        <TD>
                          <StatusBadge status={delivery.status} />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          </TabPanel>
        )}

        <TabPanel value="invoices">
          <Card>
            <CardHeader title="Invoices" />
            {(invoices.data?.data ?? []).length === 0 ? (
              <EmptyState
                icon={<Receipt className="size-5" />}
                title="No invoices yet"
                message={
                  isBuyer
                    ? 'The vendor bills against what you have accepted.'
                    : 'You can bill for goods the buyer has accepted.'
                }
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Invoice</TH>
                    <TH>Vendor number</TH>
                    <TH>Date</TH>
                    <TH numeric>Amount</TH>
                    <TH>Match</TH>
                    <TH>Status</TH>
                  </tr>
                </THead>
                <TBody>
                  {(invoices.data?.data ?? []).map((invoice) => (
                    <TR
                      key={invoice.id}
                      clickable
                      onClick={() =>
                        navigate(
                          isBuyer ? `/invoices/${invoice.id}` : `/vendor/invoices/${invoice.id}`,
                        )
                      }
                    >
                      <TD>
                        <span className="font-mono text-xs">{invoice.referenceNumber}</span>
                      </TD>
                      <TD>{invoice.vendorInvoiceNumber}</TD>
                      <TD className="text-muted">{formatDate(invoice.invoiceDate)}</TD>
                      <TD numeric>{formatMoney(invoice.totalAmount)}</TD>
                      <TD>
                        <StatusBadge status={invoice.matchStatus} />
                      </TD>
                      <TD>
                        <StatusBadge status={invoice.status} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </TabPanel>

        <TabPanel value="documents">
          <DocumentsTab
            ownerType="PURCHASE_ORDER"
            ownerId={id}
            uploadType="PO_PDF"
            canUpload={isBuyer}
          />
        </TabPanel>

        <TabPanel value="history">
          <HistoryTab entityType="PurchaseOrder" entityId={id} />
        </TabPanel>
      </Tabs>

      {/* ------------------------------ dialogs ----------------------------- */}

      <ConfirmDialog
        open={confirming === 'accept'}
        onClose={() => setConfirming(null)}
        title="Accept this purchase order?"
        message={
          <>
            You are accepting a contract for {formatMoney(data.totalAmount)}, to be delivered by{' '}
            {formatDate(data.expectedDeliveryDate)}.
          </>
        }
        confirmLabel="Accept order"
        requireReason={false}
        destructive={false}
        loading={accept.isPending}
        onConfirm={() =>
          accept.mutate(
            { id: data.id, input: {} },
            {
              onSuccess: () => {
                toast.success('Order accepted');
                setConfirming(null);
              },
              onError: (error) => toast.fromError(error),
            },
          )
        }
      />

      <ConfirmDialog
        open={confirming === 'reject'}
        onClose={() => setConfirming(null)}
        title="Reject this purchase order?"
        message="Tell the buyer what is wrong — a wrong quantity, a price that does not match the bid, a date you cannot meet. They can amend and reissue it."
        confirmLabel="Reject order"
        requireReason
        reasonMinLength={PO_REJECTION_REASON_MIN_LENGTH}
        loading={reject.isPending}
        onConfirm={(reason) =>
          reject.mutate(
            { id: data.id, input: { reason } },
            {
              onSuccess: () => {
                toast.success('Order rejected');
                setConfirming(null);
              },
              onError: (error) => toast.fromError(error),
            },
          )
        }
      />

      <ConfirmDialog
        open={confirming === 'cancel'}
        onClose={() => setConfirming(null)}
        title="Cancel this purchase order?"
        message="The vendor is notified. Anything already delivered stays on the record."
        confirmLabel="Cancel order"
        requireReason
        reasonMinLength={10}
        loading={cancel.isPending}
        onConfirm={(reason) =>
          cancel.mutate(
            { id: data.id, input: { reason } },
            {
              onSuccess: () => {
                toast.success('Order cancelled');
                setConfirming(null);
              },
              onError: (error) => toast.fromError(error),
            },
          )
        }
      />

      <ConfirmDialog
        open={confirming === 'shortClose'}
        onClose={() => setConfirming(null)}
        title="Short-close this order?"
        message="The undelivered balance is written off and the order is closed. The vendor cannot deliver against it afterwards."
        confirmLabel="Short-close"
        requireReason
        reasonMinLength={SHORT_CLOSE_REASON_MIN_LENGTH}
        loading={shortClose.isPending}
        onConfirm={(reason) =>
          shortClose.mutate(
            { id: data.id, reason },
            {
              onSuccess: () => {
                toast.success('Order short-closed');
                setConfirming(null);
              },
              onError: (error) => toast.fromError(error),
            },
          )
        }
      />

      {data.tenderId && (
        <p className="mt-4 text-xs text-muted">
          Generated from tender{' '}
          <Link
            to={isBuyer ? `/tenders/${data.tenderId}` : `/vendor/tenders/${data.tenderId}`}
            className="text-primary hover:underline"
          >
            view the tender
          </Link>
          .
        </p>
      )}
    </>
  );
}

/** `/purchase-orders/:id` */
export const PurchaseOrderDetailPage = () => <PoDetail scope="buyer" />;

/** `/vendor/purchase-orders/:id` */
export const VendorPurchaseOrderDetailPage = () => <PoDetail scope="vendor" />;
