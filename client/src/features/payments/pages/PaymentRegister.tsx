import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, Check, Download, Wallet, X } from 'lucide-react';
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PAYMENT_FAILURE_REASON_MIN_LENGTH,
  PERMISSIONS as P,
  type PaymentDto,
} from '@tb/shared';
import { formatDate, formatDateTime, formatMoney, humanize } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { usePagination } from '@/hooks/usePagination';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { FormField } from '@/components/form/FormField';
import { DatePicker } from '@/components/form/DatePicker';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import {
  downloadPaymentAdvice,
  useCancelPayment,
  useCompletePayment,
  useFailPayment,
  usePayment,
  usePayments,
  type PaymentScope,
} from '@/features/payments/api';

function Register({ scope }: { scope: PaymentScope }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const pagination = usePagination({ sort: '-paidAt' });
  const payments = usePayments(scope, pagination.params);
  const isBuyer = scope === 'buyer';

  const columns = useMemo<ColumnDef<PaymentDto, any>[]>(
    () => [
      {
        id: 'paymentNumber',
        header: 'Payment',
        accessorKey: 'paymentNumber',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs font-medium">{getValue() as string}</span>
        ),
      },
      ...(isBuyer
        ? [
            {
              id: 'vendorName',
              header: 'Vendor',
              accessorKey: 'vendorName',
              cell: ({ getValue }: { getValue: () => unknown }) => (getValue() as string) ?? '—',
            } satisfies ColumnDef<PaymentDto, any>,
          ]
        : []),
      {
        id: 'invoiceReference',
        header: 'Invoice',
        accessorKey: 'invoiceReference',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-mono text-xs">{row.original.invoiceReference ?? '—'}</p>
            <p className="truncate text-xs text-muted">{row.original.vendorInvoiceNumber}</p>
          </div>
        ),
      },
      {
        id: 'paidAt',
        header: 'Paid',
        accessorKey: 'paidAt',
        cell: ({ getValue }) => formatDate(getValue() as string),
      },
      {
        id: 'method',
        header: 'Method',
        accessorKey: 'method',
        cell: ({ row }) => (
          <div>
            <p>{row.original.method}</p>
            <p className="font-mono text-xs text-muted">{row.original.referenceNumber ?? '—'}</p>
          </div>
        ),
      },
      {
        id: 'grossAmount',
        header: 'Gross',
        accessorKey: 'grossAmount',
        meta: { numeric: true },
        cell: ({ getValue }) => formatMoney(getValue() as string),
      },
      {
        id: 'netAmount',
        header: 'Net paid',
        accessorKey: 'netAmount',
        meta: { numeric: true },
        cell: ({ getValue }) => formatMoney(getValue() as string),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
      },
    ],
    [isBuyer],
  );

  return (
    <>
      <PageHeader
        title={isBuyer ? 'Payments' : 'Payments received'}
        description={
          isBuyer
            ? 'Every payment recorded against an approved invoice.'
            : 'What has been paid to you, and against which invoice.'
        }
        actions={
          isBuyer &&
          can(P.PAYMENT_RECORD) && (
            <ButtonLink to="/payments/payable" leftIcon={<Wallet className="size-3.5" />}>
              Payables worklist
            </ButtonLink>
          )
        }
      />

      <FilterBar
        onClear={pagination.reset}
        activeCount={
          ['status', 'method'].filter((key) => pagination.getFilter(key) !== undefined).length
        }
      >
        <Select
          aria-label="Status"
          className="h-9 w-44"
          placeholder="Any status"
          value={pagination.getFilter('status') ?? ''}
          options={PAYMENT_STATUSES.map((status) => ({ value: status, label: humanize(status) }))}
          onChange={(event) => pagination.setFilter('status', event.target.value || undefined)}
        />
        <Select
          aria-label="Method"
          className="h-9 w-36"
          placeholder="Any method"
          value={pagination.getFilter('method') ?? ''}
          options={PAYMENT_METHODS.map((method) => ({ value: method, label: method }))}
          onChange={(event) => pagination.setFilter('method', event.target.value || undefined)}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        data={payments.data?.data}
        isLoading={payments.isLoading}
        isFetching={payments.isFetching}
        error={payments.error}
        onRetry={() => payments.refetch()}
        page={pagination.page}
        limit={pagination.limit}
        total={payments.data?.meta.total}
        onPageChange={pagination.setPage}
        onLimitChange={pagination.setLimit}
        sort={pagination.sort}
        onSortChange={pagination.setSort}
        getRowId={(row) => row.id}
        onRowClick={isBuyer ? (row) => navigate(`/payments/${row.id}`) : undefined}
        emptyState={
          <EmptyState
            icon={<Wallet className="size-5" />}
            title="No payments yet"
            message={
              isBuyer
                ? 'Approved invoices appear on the payables worklist, ready to pay.'
                : 'Payments appear here once the buyer releases them.'
            }
          />
        }
      />
    </>
  );
}

/** `/payments` */
export const PaymentRegisterPage = () => <Register scope="buyer" />;

/** `/vendor/payments` */
export const VendorPaymentsPage = () => <Register scope="vendor" />;

/** `/payments/:id` — one payment, and the bank outcome. */
export function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const payment = usePayment(id);
  const complete = useCompletePayment(id);
  const fail = useFailPayment(id);
  const cancel = useCancelPayment(id);

  const [completing, setCompleting] = useState(false);
  const [referenceNumber, setReferenceNumber] = useState('');
  const [valueDate, setValueDate] = useState<string | null>(new Date().toISOString());
  const [acting, setActing] = useState<'fail' | 'cancel' | null>(null);

  if (payment.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!payment.data) return <EmptyState title="Payment not found" />;

  const data = payment.data;
  const canRecord = can(P.PAYMENT_RECORD);
  const open = ['PENDING_APPROVAL', 'APPROVED'].includes(data.status);

  return (
    <>
      <PageHeader
        title={data.paymentNumber}
        status={data.status}
        backTo="/payments"
        crumbs={[{ label: 'Payments', to: '/payments' }, { label: data.paymentNumber }]}
        meta={
          <>
            <span>{data.vendorName}</span>
            <span className="font-mono tabular-nums">{formatMoney(data.netAmount)}</span>
            <span>{data.method}</span>
            <span>Paid {formatDate(data.paidAt)}</span>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              leftIcon={<Download className="size-3.5" />}
              onClick={() =>
                void downloadPaymentAdvice(data.id, data.paymentNumber).catch((error) =>
                  toast.fromError(error),
                )
              }
            >
              Advice
            </Button>

            {canRecord && data.status === 'APPROVED' && (
              <>
                <Button
                  variant="outline"
                  leftIcon={<X className="size-3.5" />}
                  onClick={() => setActing('fail')}
                >
                  Mark failed
                </Button>
                <Button leftIcon={<Check className="size-3.5" />} onClick={() => setCompleting(true)}>
                  Mark completed
                </Button>
              </>
            )}

            {canRecord && open && (
              <Button
                variant="outline"
                leftIcon={<Ban className="size-3.5" />}
                onClick={() => setActing('cancel')}
              >
                Cancel
              </Button>
            )}
          </>
        }
      />

      {data.failureReason && (
        <Card className="mb-4 border-danger/40 bg-danger/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">The bank returned this payment</p>
            <p className="text-xs text-muted">{data.failureReason}</p>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Breakdown" description="Gross less deductions is what left the account." />
          <CardBody>
            <dl className="max-w-md space-y-1.5 text-sm">
              {(
                [
                  { label: 'Gross amount', value: data.grossAmount },
                  {
                    label: `TDS${data.tdsSection ? ` (${data.tdsSection})` : ''}`,
                    value: data.tdsAmount,
                  },
                  { label: 'Retention', value: data.retentionAmount },
                  { label: 'Other deductions', value: data.otherDeduction },
                ] as const
              ).map((row) => (
                <div key={row.label} className="flex justify-between">
                  <dt className="text-muted">{row.label}</dt>
                  <dd className="numeric">{formatMoney(row.value)}</dd>
                </div>
              ))}

              <div className="flex justify-between border-t border-border-strong pt-2 font-semibold">
                <dt>Net paid</dt>
                <dd className="numeric">{formatMoney(data.netAmount)}</dd>
              </div>
            </dl>

            <p className="mt-3 text-xs text-muted italic">{data.netAmountInWords}</p>
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
                <Field label="Invoice">
                  <span className="font-mono">{data.invoiceReference ?? '—'}</span>
                  <span className="block text-xs text-muted">{data.vendorInvoiceNumber}</span>
                </Field>
                <Field label="Purchase order">
                  <span className="font-mono">{data.poNumber ?? '—'}</span>
                </Field>
                <Field label="Method">{data.method}</Field>
                <Field label="Bank reference">
                  <span className="font-mono">{data.referenceNumber ?? 'not yet'}</span>
                </Field>
                <Field label="Value date">{formatDate(data.valueDate)}</Field>
                <Field label="Recorded">{formatDateTime(data.createdAt)}</Field>
                {data.invoiceOutstanding && (
                  <Field label="Invoice still outstanding" numeric>
                    {formatMoney(data.invoiceOutstanding)}
                  </Field>
                )}
                {data.remarks && <Field label="Remarks">{data.remarks}</Field>}
              </FieldGrid>
            </CardBody>
          </Card>

          <HistoryTab entityType="Payment" entityId={id} />
        </div>
      </div>

      <Dialog
        open={completing}
        onClose={() => setCompleting(false)}
        title="Mark this payment completed"
        description="The money has actually moved and the bank gave you a reference."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCompleting(false)}>
              Cancel
            </Button>
            <Button
              loading={complete.isPending}
              disabled={referenceNumber.trim().length < 3}
              onClick={() =>
                complete.mutate(
                  {
                    referenceNumber: referenceNumber.trim(),
                    valueDate: valueDate ?? undefined,
                  },
                  {
                    onSuccess: () => {
                      toast.success('Payment completed');
                      setCompleting(false);
                    },
                    onError: (error) => toast.fromError(error),
                  },
                )
              }
            >
              Mark completed
            </Button>
          </>
        }
      >
        <FormField label="Bank reference" required hint="UTR, cheque number or transaction id.">
          <Input
            value={referenceNumber}
            autoFocus
            className="font-mono"
            onChange={(event) => setReferenceNumber(event.target.value)}
          />
        </FormField>

        <FormField label="Value date" className="mt-4">
          <DatePicker value={valueDate} onChange={setValueDate} />
        </FormField>
      </Dialog>

      <ConfirmDialog
        open={acting === 'fail'}
        onClose={() => setActing(null)}
        title="Mark this payment as failed?"
        message="The invoice goes back to outstanding and the vendor is told. Say what the bank reported."
        confirmLabel="Mark failed"
        requireReason
        reasonMinLength={PAYMENT_FAILURE_REASON_MIN_LENGTH}
        loading={fail.isPending}
        onConfirm={(reason) =>
          fail.mutate(reason, {
            onSuccess: () => {
              toast.success('Payment marked failed');
              setActing(null);
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />

      <ConfirmDialog
        open={acting === 'cancel'}
        onClose={() => setActing(null)}
        title="Cancel this payment?"
        message="Nothing has moved yet, so the invoice simply returns to the payables worklist."
        confirmLabel="Cancel payment"
        requireReason
        reasonMinLength={5}
        loading={cancel.isPending}
        onConfirm={(reason) =>
          cancel.mutate(reason, {
            onSuccess: () => {
              toast.success('Payment cancelled');
              setActing(null);
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />
    </>
  );
}
