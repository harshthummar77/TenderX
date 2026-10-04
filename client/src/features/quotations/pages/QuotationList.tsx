import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { FileSignature } from 'lucide-react';
import { QUOTATION_STATUSES, type QuotationVendorDto } from '@tb/shared';
import { formatMoney, humanize } from '@/lib/format';
import { usePagination } from '@/hooks/usePagination';
import { Select } from '@/components/ui/select';
import { Countdown } from '@/components/Countdown';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { ButtonLink } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/PageHeader';
import { useMyQuotations } from '@/features/quotations/api';

/** `/vendor/quotations` — the vendor's own bids, with their status. */
export function QuotationListPage() {
  const navigate = useNavigate();
  const pagination = usePagination({ sort: '-createdAt' });
  const quotations = useMyQuotations(pagination.params);

  const columns = useMemo<ColumnDef<QuotationVendorDto, any>[]>(
    () => [
      {
        id: 'referenceNumber',
        header: 'Reference',
        accessorKey: 'referenceNumber',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-mono text-xs font-medium">
              {row.original.referenceNumber || 'Draft'}
            </p>
            <p className="truncate text-xs text-muted">{row.original.tenderTitle}</p>
          </div>
        ),
      },
      {
        id: 'tenderReferenceNumber',
        header: 'Tender',
        accessorKey: 'tenderReferenceNumber',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs">{(getValue() as string) ?? '—'}</span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <StatusBadge status={row.original.status} />
            {row.original.revisionNumber > 1 && (
              <span className="text-xs text-muted">r{row.original.revisionNumber}</span>
            )}
          </span>
        ),
      },
      {
        id: 'grandTotal',
        header: 'Your bid',
        accessorKey: 'grandTotal',
        meta: { numeric: true },
        cell: ({ row }) =>
          row.original.status === 'DRAFT' && Number(row.original.grandTotal) === 0
            ? '—'
            : formatMoney(row.original.grandTotal),
      },
      {
        id: 'deliveryDays',
        header: 'Delivery',
        accessorKey: 'deliveryDays',
        meta: { numeric: true },
        cell: ({ getValue }) => `${getValue() as number} d`,
      },
      {
        id: 'bidSubmissionDeadline',
        header: 'Closes',
        accessorKey: 'bidSubmissionDeadline',
        cell: ({ row }) => (
          <Countdown deadline={row.original.bidSubmissionDeadline} showIcon={false} />
        ),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="My quotations"
        description="Every bid you have drafted, submitted or won."
        actions={
          <ButtonLink to="/vendor/tenders" variant="outline">
            Find tenders to bid on
          </ButtonLink>
        }
      />

      <FilterBar
        onClear={pagination.reset}
        activeCount={pagination.getFilter('status') ? 1 : 0}
      >
        <Select
          aria-label="Status"
          className="h-9 w-44"
          placeholder="Any status"
          value={pagination.getFilter('status') ?? ''}
          options={QUOTATION_STATUSES.map((status) => ({ value: status, label: humanize(status) }))}
          onChange={(event) => pagination.setFilter('status', event.target.value || undefined)}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        data={quotations.data?.data}
        isLoading={quotations.isLoading}
        isFetching={quotations.isFetching}
        error={quotations.error}
        onRetry={() => quotations.refetch()}
        page={pagination.page}
        limit={pagination.limit}
        total={quotations.data?.meta.total}
        onPageChange={pagination.setPage}
        onLimitChange={pagination.setLimit}
        sort={pagination.sort}
        onSortChange={pagination.setSort}
        getRowId={(row) => row.id}
        onRowClick={(row) =>
          navigate(
            row.status === 'DRAFT'
              ? `/vendor/quotations/${row.id}/edit`
              : `/vendor/quotations/${row.id}`,
          )
        }
        emptyState={
          <EmptyState
            icon={<FileSignature className="size-5" />}
            title="No bids yet"
            message="Tenders you have been invited to appear under Tenders. Open one to price it."
            action={
              <ButtonLink to="/vendor/tenders" size="sm">
                See open tenders
              </ButtonLink>
            }
          />
        }
      />
    </>
  );
}
