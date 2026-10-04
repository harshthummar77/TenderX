import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Receipt } from 'lucide-react';
import { INVOICE_STATUSES, MATCH_STATUSES, type InvoiceDto } from '@tb/shared';
import { formatDate, formatMoney, humanize } from '@/lib/format';
import { usePagination } from '@/hooks/usePagination';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { PageHeader } from '@/components/layout/PageHeader';
import { useInvoices, type InvoiceScope } from '@/features/invoices/api';

function InvoiceList({ scope }: { scope: InvoiceScope }) {
  const navigate = useNavigate();
  const pagination = usePagination({ sort: '-invoiceDate' });
  const invoices = useInvoices(scope, pagination.params);
  const isBuyer = scope === 'buyer';

  const columns = useMemo<ColumnDef<InvoiceDto, any>[]>(
    () => [
      {
        id: 'referenceNumber',
        header: 'Invoice',
        accessorKey: 'referenceNumber',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-mono text-xs font-medium">{row.original.referenceNumber}</p>
            <p className="truncate text-xs text-muted">{row.original.vendorInvoiceNumber}</p>
          </div>
        ),
      },
      ...(isBuyer
        ? [
            {
              id: 'vendorName',
              header: 'Vendor',
              accessorKey: 'vendorName',
              cell: ({ getValue }: { getValue: () => unknown }) =>
                (getValue() as string) ?? '—',
            } satisfies ColumnDef<InvoiceDto, any>,
          ]
        : []),
      {
        id: 'poNumber',
        header: 'Order',
        accessorKey: 'poNumber',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs">{(getValue() as string) ?? '—'}</span>
        ),
      },
      {
        id: 'invoiceDate',
        header: 'Dated',
        accessorKey: 'invoiceDate',
        cell: ({ getValue }) => formatDate(getValue() as string),
      },
      {
        id: 'dueDate',
        header: 'Due',
        accessorKey: 'dueDate',
        cell: ({ row }) => (
          <span className={row.original.daysOverdue > 0 ? 'text-danger' : undefined}>
            {formatDate(row.original.dueDate)}
            {row.original.daysOverdue > 0 && (
              <span className="block text-xs">{row.original.daysOverdue} days overdue</span>
            )}
          </span>
        ),
      },
      {
        id: 'totalAmount',
        header: 'Amount',
        accessorKey: 'totalAmount',
        meta: { numeric: true },
        cell: ({ getValue }) => formatMoney(getValue() as string),
      },
      {
        id: 'outstanding',
        header: 'Outstanding',
        accessorKey: 'outstanding',
        meta: { numeric: true },
        cell: ({ getValue }) => formatMoney(getValue() as string),
      },
      {
        id: 'matchStatus',
        header: 'Match',
        accessorKey: 'matchStatus',
        cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
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
        title={isBuyer ? 'Invoices' : 'My invoices'}
        description={
          isBuyer
            ? 'Vendor bills, with the three-way match result on every row.'
            : 'What you have billed, and where each invoice stands.'
        }
      />

      <FilterBar
        search={pagination.q}
        onSearchChange={pagination.setQuery}
        searchPlaceholder="Search invoice or PO number…"
        onClear={pagination.reset}
        activeCount={
          ['status', 'matchStatus', 'overdue'].filter(
            (key) => pagination.getFilter(key) !== undefined,
          ).length
        }
      >
        <Select
          aria-label="Status"
          className="h-9 w-48"
          placeholder="Any status"
          value={pagination.getFilter('status') ?? ''}
          options={INVOICE_STATUSES.map((status) => ({ value: status, label: humanize(status) }))}
          onChange={(event) => pagination.setFilter('status', event.target.value || undefined)}
        />

        {isBuyer && (
          <Select
            aria-label="Match status"
            className="h-9 w-44"
            placeholder="Any match"
            value={pagination.getFilter('matchStatus') ?? ''}
            options={MATCH_STATUSES.map((status) => ({ value: status, label: humanize(status) }))}
            onChange={(event) =>
              pagination.setFilter('matchStatus', event.target.value || undefined)
            }
          />
        )}

        <Select
          aria-label="Overdue"
          className="h-9 w-36"
          placeholder="Any age"
          value={pagination.getFilter('overdue') ?? ''}
          options={[{ value: 'true', label: 'Overdue only' }]}
          onChange={(event) => pagination.setFilter('overdue', event.target.value || undefined)}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        data={invoices.data?.data}
        isLoading={invoices.isLoading}
        isFetching={invoices.isFetching}
        error={invoices.error}
        onRetry={() => invoices.refetch()}
        page={pagination.page}
        limit={pagination.limit}
        total={invoices.data?.meta.total}
        onPageChange={pagination.setPage}
        onLimitChange={pagination.setLimit}
        sort={pagination.sort}
        onSortChange={pagination.setSort}
        getRowId={(row) => row.id}
        rowClassName={(row) => (row.matchStatus === 'EXCEPTION' ? 'bg-danger/5' : undefined)}
        onRowClick={(row) =>
          navigate(isBuyer ? `/invoices/${row.id}` : `/vendor/invoices/${row.id}`)
        }
        emptyState={
          <EmptyState
            icon={<Receipt className="size-5" />}
            title="No invoices"
            message={
              isBuyer
                ? 'Invoices appear here when a vendor bills against an accepted order.'
                : 'Open an accepted purchase order to raise your first invoice.'
            }
          />
        }
      />
    </>
  );
}

/** `/invoices` */
export const InvoiceListPage = () => <InvoiceList scope="buyer" />;

/** `/vendor/invoices` */
export const VendorInvoiceListPage = () => <InvoiceList scope="vendor" />;
