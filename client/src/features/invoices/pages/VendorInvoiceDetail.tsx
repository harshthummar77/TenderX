import { useParams } from 'react-router-dom';
import { Download, Send } from 'lucide-react';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/data/EmptyState';
import { StatusBadge } from '@/components/data/StatusBadge';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import { MatchChecklist } from '@/features/invoices/components/MatchChecklist';
import { downloadInvoicePdf, useInvoice, useSubmitInvoice } from '@/features/invoices/api';

/**
 * `/vendor/invoices/:id` — the vendor's own invoice.
 *
 * The rejection reason is the point of this screen: a bounced invoice is useless
 * to a vendor without the sentence that says what to fix, so it is the first
 * thing on the page rather than something buried in the history tab.
 */
export function VendorInvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useQueryTab('invoice');
  const invoice = useInvoice('vendor', id);
  const submit = useSubmitInvoice(id);

  if (invoice.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!invoice.data) return <EmptyState title="Invoice not found" />;

  const data = invoice.data;

  return (
    <>
      <PageHeader
        title={data.referenceNumber}
        status={data.status}
        backTo="/vendor/invoices"
        crumbs={[{ label: 'My invoices', to: '/vendor/invoices' }, { label: data.referenceNumber }]}
        meta={
          <>
            <span className="font-mono">{data.vendorInvoiceNumber}</span>
            <span className="font-mono">{data.poNumber ?? '—'}</span>
            <span className="font-mono tabular-nums">{formatMoney(data.totalAmount)}</span>
            <span>Due {formatDate(data.dueDate)}</span>
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

            {data.status === 'DRAFT' && (
              <Button
                leftIcon={<Send className="size-3.5" />}
                loading={submit.isPending}
                onClick={() =>
                  submit.mutate(undefined, {
                    onSuccess: () => toast.success('Invoice submitted'),
                    onError: (error) => toast.fromError(error),
                  })
                }
              >
                Submit to buyer
              </Button>
            )}
          </>
        }
      />

      {data.rejectionReason && (
        <Card className="mb-4 border-danger/40 bg-danger/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">The buyer rejected this invoice</p>
            <p className="mt-0.5 text-xs text-muted">{data.rejectionReason}</p>
            <p className="mt-2 text-xs text-muted">
              Correct it and raise a new invoice against the same purchase order.
            </p>
          </CardBody>
        </Card>
      )}

      {data.matchStatus === 'EXCEPTION' && (
        <Card className="mb-4 border-warning/40 bg-warning/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">The three-way match found a problem</p>
            <p className="mt-0.5 text-xs text-muted">
              The buyer is reviewing it. The checks below show exactly which line and why.
            </p>
          </CardBody>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="invoice">Invoice</Tab>
          <Tab value="match">Match</Tab>
          <Tab value="documents">Documents</Tab>
          <Tab value="history">History</Tab>
        </TabList>

        <TabPanel value="invoice">
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <Card>
              <CardHeader title="Lines" />
              <Table>
                <THead>
                  <tr>
                    <TH>#</TH>
                    <TH>Description</TH>
                    <TH numeric>Quantity</TH>
                    <TH numeric>Rate</TH>
                    <TH numeric>Taxable</TH>
                    <TH numeric>Line total</TH>
                  </tr>
                </THead>
                <TBody>
                  {data.items.map((item) => (
                    <TR key={item.id}>
                      <TD className="font-mono text-xs text-muted">{item.srNo ?? '—'}</TD>
                      <TD>{item.description}</TD>
                      <TD numeric>{formatQty(item.quantity, item.unit)}</TD>
                      <TD numeric>{formatMoney(item.unitPrice)}</TD>
                      <TD numeric>{formatMoney(item.taxableValue)}</TD>
                      <TD numeric>{formatMoney(item.lineTotal)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>

            <Card className="h-fit">
              <CardHeader title="Money" />
              <CardBody>
                <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
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
              </CardBody>
            </Card>
          </div>
        </TabPanel>

        <TabPanel value="match">
          <Card>
            <CardHeader
              title="Three-way match"
              description="Your invoice against the purchase order and what the buyer accepted."
              actions={<StatusBadge status={data.matchStatus} size="md" />}
            />
            <CardBody>
              <MatchChecklist checks={data.matchResult} />
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="documents">
          <DocumentsTab
            ownerType="INVOICE"
            ownerId={id}
            uploadType="INVOICE_PDF"
            canUpload={data.status === 'DRAFT'}
          />
        </TabPanel>

        <TabPanel value="history">
          <HistoryTab entityType="Invoice" entityId={id} />
        </TabPanel>
      </Tabs>
    </>
  );
}
