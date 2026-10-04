import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Star, Store } from 'lucide-react';
import { VENDOR_STATUSES, type VendorPublicDto } from '@tb/shared';
import { formatCount, formatPercent, humanize } from '@/lib/format';
import { usePagination } from '@/hooks/usePagination';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { PageHeader } from '@/components/layout/PageHeader';
import { useCategories, useVendors } from '@/features/vendors/api';

/** A rating of `null` means "no history", which is not the same as zero (06 §4). */
function Rating({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted">no data</span>;
  return (
    <span className="inline-flex items-center gap-1 font-mono tabular-nums">
      <Star aria-hidden className="size-3 fill-warning text-warning" />
      {value.toFixed(1)}
    </span>
  );
}

/** `/vendors` — the buyer's directory: search, category, rating, status. */
export function VendorListPage() {
  const navigate = useNavigate();
  const pagination = usePagination({ sort: '-createdAt' });
  const categories = useCategories();
  const vendors = useVendors(pagination.params);

  const columns = useMemo<ColumnDef<VendorPublicDto, any>[]>(
    () => [
      {
        id: 'companyName',
        header: 'Vendor',
        accessorKey: 'companyName',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-text">{row.original.companyName}</p>
            <p className="truncate text-xs text-muted">
              {row.original.city}, {row.original.state}
            </p>
          </div>
        ),
      },
      {
        id: 'gstin',
        header: 'GSTIN',
        accessorKey: 'gstin',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs">{(getValue() as string) ?? '—'}</span>
        ),
      },
      {
        id: 'categories',
        header: 'Categories',
        enableSorting: false,
        cell: ({ row }) => {
          const names = row.original.categories.map((category) => category.name);
          if (names.length === 0) return <span className="text-xs text-muted">—</span>;
          return (
            <span className="text-xs">
              {names.slice(0, 2).join(', ')}
              {names.length > 2 && <span className="text-muted"> +{names.length - 2}</span>}
            </span>
          );
        },
      },
      {
        id: 'rating',
        header: 'Rating',
        meta: { numeric: true },
        cell: ({ row }) => <Rating value={row.original.rating} />,
      },
      {
        id: 'totalOrders',
        header: 'Orders',
        accessorKey: 'totalOrders',
        meta: { numeric: true },
        cell: ({ getValue }) => formatCount(getValue() as number),
      },
      {
        id: 'onTimeDeliveryRate',
        header: 'On time',
        meta: { numeric: true },
        cell: ({ row }) =>
          row.original.onTimeDeliveryRate === null ? (
            <span className="text-xs text-muted">no data</span>
          ) : (
            formatPercent(row.original.onTimeDeliveryRate, 0)
          ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
      },
    ],
    [],
  );

  const activeFilters = ['status', 'categoryId', 'minRating'].filter(
    (key) => pagination.getFilter(key) !== undefined,
  ).length;

  return (
    <>
      <PageHeader title="Vendors" description="Approved suppliers you can invite to a tender." />

      <FilterBar
        search={pagination.q}
        onSearchChange={pagination.setQuery}
        searchPlaceholder="Search name, GSTIN or city…"
        onClear={pagination.reset}
        activeCount={activeFilters}
      >
        <Select
          aria-label="Status"
          className="h-9 w-44"
          placeholder="Any status"
          value={pagination.getFilter('status') ?? ''}
          options={VENDOR_STATUSES.map((status) => ({ value: status, label: humanize(status) }))}
          onChange={(event) => pagination.setFilter('status', event.target.value || undefined)}
        />

        <Select
          aria-label="Category"
          className="h-9 w-48"
          placeholder="Any category"
          value={pagination.getFilter('categoryId') ?? ''}
          options={(categories.data ?? []).map((category) => ({
            value: category.id,
            label: category.name,
          }))}
          onChange={(event) => pagination.setFilter('categoryId', event.target.value || undefined)}
        />

        <Select
          aria-label="Minimum rating"
          className="h-9 w-40"
          placeholder="Any rating"
          value={pagination.getFilter('minRating') ?? ''}
          options={[
            { value: '4.5', label: '4.5 and above' },
            { value: '4', label: '4.0 and above' },
            { value: '3', label: '3.0 and above' },
          ]}
          onChange={(event) => pagination.setFilter('minRating', event.target.value || undefined)}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        data={vendors.data?.data}
        isLoading={vendors.isLoading}
        isFetching={vendors.isFetching}
        error={vendors.error}
        onRetry={() => vendors.refetch()}
        page={pagination.page}
        limit={pagination.limit}
        total={vendors.data?.meta.total}
        onPageChange={pagination.setPage}
        onLimitChange={pagination.setLimit}
        sort={pagination.sort}
        onSortChange={pagination.setSort}
        getRowId={(row) => row.id}
        onRowClick={(row) => navigate(`/vendors/${row.id}`)}
        emptyState={
          <EmptyState
            icon={<Store className="size-5" />}
            title="No vendors match this view"
            message={
              activeFilters > 0 || pagination.q
                ? 'Try clearing the filters.'
                : 'Vendors appear here once they register and are approved.'
            }
          />
        }
      />
    </>
  );
}
