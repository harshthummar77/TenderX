import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { PackageCheck } from 'lucide-react';
import { GRN_STATUSES, type GrnDto } from '@tb/shared';
import { formatDateTime, formatQty, humanize } from '@/lib/format';
import { usePagination } from '@/hooks/usePagination';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { useGrn, useGrns } from '@/features/grns/api';

/** `/grns` — everything received, newest first. */
export function GrnListPage() {
  const navigate = useNavigate();
  const pagination = usePagination({ sort: '-receivedAt' });
  const grns = useGrns(pagination.params);

  const columns = useMemo<ColumnDef<GrnDto, any>[]>(
    () => [
      {
        id: 'grnNumber',
        header: 'GRN',
        accessorKey: 'grnNumber',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs font-medium">{getValue() as string}</span>
        ),
      },
      {
        id: 'poNumber',
        header: 'Purchase order',
        accessorKey: 'poNumber',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs">{(getValue() as string) ?? '—'}</span>
        ),
      },
      {
        id: 'challanNumber',
        header: 'Challan',
        accessorKey: 'challanNumber',
        cell: ({ getValue }) => (getValue() as string) ?? '—',
      },
      {
        id: 'receivedAt',
        header: 'Received',
        accessorKey: 'receivedAt',
        cell: ({ getValue }) => formatDateTime(getValue() as string),
      },
      {
        id: 'receivedByName',
        header: 'By',
        accessorKey: 'receivedByName',
        cell: ({ getValue }) => (getValue() as string) ?? '—',
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

  return (
    <>
      <PageHeader
        title="Goods receipts"
        description="What has actually arrived, and what was accepted. This is what invoices are matched against."
      />

      <FilterBar onClear={pagination.reset} activeCount={pagination.getFilter('status') ? 1 : 0}>
        <Select
          aria-label="Status"
          className="h-9 w-48"
          placeholder="Any status"
          value={pagination.getFilter('status') ?? ''}
          options={GRN_STATUSES.map((status) => ({ value: status, label: humanize(status) }))}
          onChange={(event) => pagination.setFilter('status', event.target.value || undefined)}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        data={grns.data?.data}
        isLoading={grns.isLoading}
        isFetching={grns.isFetching}
        error={grns.error}
        onRetry={() => grns.refetch()}
        page={pagination.page}
        limit={pagination.limit}
        total={grns.data?.meta.total}
        onPageChange={pagination.setPage}
        onLimitChange={pagination.setLimit}
        sort={pagination.sort}
        onSortChange={pagination.setSort}
        getRowId={(row) => row.id}
        onRowClick={(row) => navigate(`/grns/${row.id}`)}
        emptyState={
          <EmptyState
            icon={<PackageCheck className="size-5" />}
            title="Nothing received yet"
            message="Open an accepted purchase order and record a goods receipt when the delivery arrives."
          />
        }
      />
    </>
  );
}

/** `/grns/:id` */
export function GrnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const grn = useGrn(id);

  if (grn.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!grn.data) return <EmptyState title="Goods receipt not found" />;

  const data = grn.data;

  return (
    <>
      <PageHeader
        title={data.grnNumber}
        status={data.status}
        backTo="/grns"
        crumbs={[{ label: 'Goods receipts', to: '/grns' }, { label: data.grnNumber }]}
        meta={
          <>
            <span className="font-mono">{data.poNumber ?? '—'}</span>
            <span>Received {formatDateTime(data.receivedAt)}</span>
            <span>by {data.receivedByName ?? '—'}</span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <Card>
          <CardHeader
            title="Lines"
            description="The status is derived from these quantities, never chosen."
          />
          <Table>
            <THead>
              <tr>
                <TH>#</TH>
                <TH>Description</TH>
                <TH numeric>Received</TH>
                <TH numeric>Accepted</TH>
                <TH numeric>Rejected</TH>
                <TH>Rejection reason</TH>
              </tr>
            </THead>
            <TBody>
              {data.items.map((item) => (
                <TR key={item.id}>
                  <TD className="font-mono text-xs text-muted">{item.srNo ?? '—'}</TD>
                  <TD>{item.description ?? '—'}</TD>
                  <TD numeric>{formatQty(item.receivedQuantity, item.unit)}</TD>
                  <TD numeric>{formatQty(item.acceptedQuantity)}</TD>
                  <TD
                    numeric
                    className={Number(item.rejectedQuantity) > 0 ? 'text-danger' : undefined}
                  >
                    {formatQty(item.rejectedQuantity)}
                  </TD>
                  <TD className="max-w-xs text-xs text-muted">{item.rejectionReason ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Receipt" />
            <CardBody>
              <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
                <Field label="Challan">{data.challanNumber ?? '—'}</Field>
                <Field label="Received at">{formatDateTime(data.receivedAt)}</Field>
                <Field label="Received by">{data.receivedByName ?? '—'}</Field>
                {data.remarks && <Field label="Remarks">{data.remarks}</Field>}
              </FieldGrid>
            </CardBody>
          </Card>

          <HistoryTab entityType="Grn" entityId={id} />
        </div>
      </div>
    </>
  );
}
