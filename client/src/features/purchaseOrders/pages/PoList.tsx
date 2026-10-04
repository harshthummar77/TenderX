import { useNavigate } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { FULFILMENT_STATUSES, PO_STATUSES } from '@tb/shared';
import { humanize } from '@/lib/format';
import { usePagination } from '@/hooks/usePagination';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { PageHeader } from '@/components/layout/PageHeader';
import { poColumns } from '@/features/purchaseOrders/components/poColumns';
import { usePurchaseOrders, type PoScope } from '@/features/purchaseOrders/api';

function PoList({ scope }: { scope: PoScope }) {
  const navigate = useNavigate();
  const pagination = usePagination({ sort: '-createdAt' });
  const orders = usePurchaseOrders(scope, pagination.params);

  const side = scope === 'vendor' ? 'vendor' : 'buyer';
  const detailBase = scope === 'vendor' ? '/vendor/purchase-orders' : '/purchase-orders';

  return (
    <>
      <PageHeader
        title={scope === 'vendor' ? 'My orders' : 'Purchase orders'}
        description={
          scope === 'vendor'
            ? 'Orders buyers have issued to you. Accepting one is accepting the contract.'
            : 'Orders issued to your vendors, with how much of each has arrived.'
        }
      />

      <FilterBar
        search={pagination.q}
        onSearchChange={pagination.setQuery}
        searchPlaceholder="Search PO number or party…"
        onClear={pagination.reset}
        activeCount={
          ['status', 'fulfilmentStatus'].filter((key) => pagination.getFilter(key) !== undefined)
            .length
        }
      >
        <Select
          aria-label="Status"
          className="h-9 w-40"
          placeholder="Any status"
          value={pagination.getFilter('status') ?? ''}
          options={PO_STATUSES.map((status) => ({ value: status, label: humanize(status) }))}
          onChange={(event) => pagination.setFilter('status', event.target.value || undefined)}
        />
        <Select
          aria-label="Fulfilment"
          className="h-9 w-48"
          placeholder="Any fulfilment"
          value={pagination.getFilter('fulfilmentStatus') ?? ''}
          options={FULFILMENT_STATUSES.map((status) => ({
            value: status,
            label: humanize(status),
          }))}
          onChange={(event) =>
            pagination.setFilter('fulfilmentStatus', event.target.value || undefined)
          }
        />
      </FilterBar>

      <DataTable
        columns={poColumns({ side })}
        data={orders.data?.data}
        isLoading={orders.isLoading}
        isFetching={orders.isFetching}
        error={orders.error}
        onRetry={() => orders.refetch()}
        page={pagination.page}
        limit={pagination.limit}
        total={orders.data?.meta.total}
        onPageChange={pagination.setPage}
        onLimitChange={pagination.setLimit}
        sort={pagination.sort}
        onSortChange={pagination.setSort}
        getRowId={(row) => row.id}
        onRowClick={(row) => navigate(`${detailBase}/${row.id}`)}
        emptyState={
          <EmptyState
            icon={<ClipboardList className="size-5" />}
            title="No purchase orders"
            message={
              scope === 'vendor'
                ? 'Orders appear here when a buyer awards you a tender.'
                : 'An order is generated automatically when an award is approved.'
            }
          />
        }
      />
    </>
  );
}

/** `/purchase-orders` */
export const PurchaseOrderListPage = () => <PoList scope="buyer" />;

/** `/vendor/purchase-orders` */
export const VendorPurchaseOrderListPage = () => <PoList scope="vendor" />;
