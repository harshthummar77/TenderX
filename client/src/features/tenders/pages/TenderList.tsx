import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Gavel, Plus } from 'lucide-react';
import { PERMISSIONS as P, type TenderBuyerDto } from '@tb/shared';
import { formatCount, formatMoney } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { usePagination } from '@/hooks/usePagination';
import { ButtonLink } from '@/components/ui/button';
import { Tab, TabList, Tabs } from '@/components/ui/tabs';
import { Countdown } from '@/components/Countdown';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTenders } from '@/features/tenders/api';
import { useCategories } from '@/features/vendors/api';
import { Select } from '@/components/ui/select';

/**
 * Status tabs rather than only a dropdown: "Live" and "Evaluating" are the two
 * views an officer actually works from, and a tab makes them one click.
 *
 * Each tab is a status filter in the URL, so every one of them is a shareable
 * link (plan 17 §8).
 */
const TABS = [
  { value: '', label: 'All' },
  { value: 'DRAFT', label: 'Drafts' },
  { value: 'PUBLISHED', label: 'Live' },
  { value: 'UNDER_EVALUATION', label: 'Evaluating' },
  { value: 'AWARDED', label: 'Awarded' },
] as const;

/** `/tenders` — the buyer's list. */
export function TenderListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const pagination = usePagination({ sort: '-createdAt' });
  const categories = useCategories();
  const tenders = useTenders(pagination.params);

  const activeStatus = pagination.getFilter('status') ?? '';

  const columns = useMemo<ColumnDef<TenderBuyerDto, any>[]>(
    () => [
      {
        id: 'referenceNumber',
        header: 'Reference',
        accessorKey: 'referenceNumber',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-mono text-xs font-medium">
              {row.original.referenceNumber ?? 'Draft'}
            </p>
            <p className="truncate text-xs text-muted">{row.original.title}</p>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
      },
      {
        id: 'category',
        header: 'Category',
        enableSorting: false,
        cell: ({ row }) => row.original.category?.name ?? '—',
      },
      {
        id: 'estimatedBudget',
        header: 'Budget',
        accessorKey: 'estimatedBudget',
        meta: { numeric: true },
        cell: ({ getValue }) => {
          const value = getValue() as string | null;
          return value ? formatMoney(value) : '—';
        },
      },
      {
        id: 'quotationCount',
        header: 'Bids',
        accessorKey: 'quotationCount',
        meta: { numeric: true },
        cell: ({ row }) => (
          <span>
            {formatCount(row.original.quotationCount)}
            <span className="text-muted"> / {formatCount(row.original.invitationCount)}</span>
          </span>
        ),
      },
      {
        id: 'bidSubmissionDeadline',
        header: 'Closes',
        accessorKey: 'bidSubmissionDeadline',
        cell: ({ row }) =>
          row.original.status === 'PUBLISHED' ? (
            <Countdown deadline={row.original.bidSubmissionDeadline} showIcon={false} />
          ) : (
            <span className="font-mono text-xs text-muted">
              {new Date(row.original.bidSubmissionDeadline).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          ),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Tenders"
        description="Everything your organization has put to market."
        actions={
          can(P.TENDER_CREATE) && (
            <ButtonLink to="/tenders/new" leftIcon={<Plus className="size-3.5" />}>
              New tender
            </ButtonLink>
          )
        }
      />

      <Tabs
        value={activeStatus}
        onValueChange={(value) => pagination.setFilter('status', value || undefined)}
        className="mb-4"
      >
        <TabList>
          {TABS.map((tab) => (
            <Tab key={tab.value} value={tab.value}>
              {tab.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>

      <FilterBar
        search={pagination.q}
        onSearchChange={pagination.setQuery}
        searchPlaceholder="Search reference or title…"
        onClear={pagination.reset}
        activeCount={
          ['status', 'categoryId'].filter((key) => pagination.getFilter(key) !== undefined).length
        }
      >
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
      </FilterBar>

      <DataTable
        columns={columns}
        data={tenders.data?.data}
        isLoading={tenders.isLoading}
        isFetching={tenders.isFetching}
        error={tenders.error}
        onRetry={() => tenders.refetch()}
        page={pagination.page}
        limit={pagination.limit}
        total={tenders.data?.meta.total}
        onPageChange={pagination.setPage}
        onLimitChange={pagination.setLimit}
        sort={pagination.sort}
        onSortChange={pagination.setSort}
        getRowId={(row) => row.id}
        onRowClick={(row) => navigate(`/tenders/${row.id}`)}
        emptyState={
          <EmptyState
            icon={<Gavel className="size-5" />}
            title={activeStatus ? `No ${activeStatus.toLowerCase()} tenders` : 'No tenders yet'}
            message={
              activeStatus
                ? 'Try another tab, or clear the filters.'
                : 'Create your first tender and invite vendors to bid.'
            }
            action={
              can(P.TENDER_CREATE) && !activeStatus ? (
                <ButtonLink to="/tenders/new" size="sm">
                  Create your first tender
                </ButtonLink>
              ) : undefined
            }
          />
        }
      />
    </>
  );
}
