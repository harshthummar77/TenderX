import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, Check, Pause, X } from 'lucide-react';
import {
  ORGANIZATION_STATUSES,
  PERMISSIONS as P,
  type PlatformOrgListItem,
} from '@tb/shared';
import { formatCount, formatDate, humanize } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { usePagination } from '@/hooks/usePagination';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select } from '@/components/ui/select';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { Completion } from '@/components/data/Completion';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import {
  useOrganizationDecision,
  usePlatformOrganization,
  usePlatformOrganizations,
} from '@/features/platform/api';

/** `/platform/organizations` — the queue of tenants waiting to be let in. */
export function PlatformOrganizationsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const pagination = usePagination({ sort: '-createdAt' });
  const organizations = usePlatformOrganizations(pagination.params);

  const columns = useMemo<ColumnDef<PlatformOrgListItem, any>[]>(
    () => [
      {
        id: 'name',
        header: 'Organization',
        accessorKey: 'name',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.name}</p>
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
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
      },
      {
        id: 'completionScore',
        header: 'Profile',
        accessorKey: 'completionScore',
        meta: { numeric: true },
        cell: ({ getValue }) => `${getValue() as number}%`,
      },
      {
        id: 'userCount',
        header: 'Users',
        accessorKey: 'userCount',
        meta: { numeric: true },
        cell: ({ getValue }) => formatCount(getValue() as number),
      },
      {
        id: 'tenderCount',
        header: 'Tenders',
        accessorKey: 'tenderCount',
        meta: { numeric: true },
        cell: ({ getValue }) => formatCount(getValue() as number),
      },
      {
        id: 'createdAt',
        header: 'Registered',
        accessorKey: 'createdAt',
        cell: ({ getValue }) => formatDate(getValue() as string),
      },
    ],
    [],
  );

  // After every hook: a conditional return above one would change the hook order
  // between renders.
  if (!can(P.ORG_APPROVE)) return <Forbidden />;

  return (
    <>
      <PageHeader
        title="Organizations"
        description="Buying organizations on the platform. Approve one to let it publish tenders."
      />

      <FilterBar
        search={pagination.q}
        onSearchChange={pagination.setQuery}
        searchPlaceholder="Search name or GSTIN…"
        onClear={pagination.reset}
        activeCount={pagination.getFilter('status') ? 1 : 0}
      >
        <Select
          aria-label="Status"
          className="h-9 w-48"
          placeholder="Any status"
          value={pagination.getFilter('status') ?? ''}
          options={ORGANIZATION_STATUSES.map((status) => ({
            value: status,
            label: humanize(status),
          }))}
          onChange={(event) => pagination.setFilter('status', event.target.value || undefined)}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        data={organizations.data?.data}
        isLoading={organizations.isLoading}
        isFetching={organizations.isFetching}
        error={organizations.error}
        onRetry={() => organizations.refetch()}
        page={pagination.page}
        limit={pagination.limit}
        total={organizations.data?.meta.total}
        onPageChange={pagination.setPage}
        onLimitChange={pagination.setLimit}
        sort={pagination.sort}
        onSortChange={pagination.setSort}
        getRowId={(row) => row.id}
        onRowClick={(row) => navigate(`/platform/organizations/${row.id}`)}
        emptyState={
          <EmptyState
            icon={<Building2 className="size-5" />}
            title="No organizations yet"
            message="Organizations appear here as soon as they register."
          />
        }
      />
    </>
  );
}

type Decision = 'approve' | 'reject' | 'suspend';

/** `/platform/organizations/:id` — the review screen. */
export function PlatformOrganizationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('profile');
  const organization = usePlatformOrganization(id);
  const decide = useOrganizationDecision(id);
  const [pending, setPending] = useState<Decision | null>(null);

  if (!can(P.ORG_APPROVE)) return <Forbidden />;

  if (organization.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!organization.data) {
    return <EmptyState title="Organization not found" />;
  }

  const data = organization.data;

  const DECISIONS: Record<
    Decision,
    { title: string; message: string; confirmLabel: string; requireReason: boolean }
  > = {
    approve: {
      title: 'Approve this organization?',
      message: `${data.name} will be able to invite vendors, publish tenders and issue purchase orders.`,
      confirmLabel: 'Approve',
      requireReason: false,
    },
    reject: {
      title: 'Reject this organization?',
      message: 'They will be told why. They can fix the problem and re-apply.',
      confirmLabel: 'Reject',
      requireReason: true,
    },
    suspend: {
      title: 'Suspend this organization?',
      message:
        'Existing records stay intact, but nobody there can start new work until it is reinstated.',
      confirmLabel: 'Suspend',
      requireReason: true,
    },
  };

  return (
    <>
      <PageHeader
        title={data.name}
        status={data.status}
        backTo="/platform/organizations"
        crumbs={[
          { label: 'Organizations', to: '/platform/organizations' },
          { label: data.name },
        ]}
        meta={
          <>
            <span className="font-mono">{data.gstin ?? 'No GSTIN'}</span>
            <span>
              {data.city}, {data.state}
            </span>
            <span>Registered {formatDate(data.createdAt)}</span>
          </>
        }
        actions={
          <>
            {data.status === 'PENDING_APPROVAL' && (
              <>
                <Button
                  variant="outline"
                  leftIcon={<X className="size-3.5" />}
                  onClick={() => setPending('reject')}
                >
                  Reject
                </Button>
                <Button
                  leftIcon={<Check className="size-3.5" />}
                  onClick={() => setPending('approve')}
                >
                  Approve
                </Button>
              </>
            )}
            {data.status === 'ACTIVE' && (
              <Button
                variant="outline"
                leftIcon={<Pause className="size-3.5" />}
                onClick={() => setPending('suspend')}
              >
                Suspend
              </Button>
            )}
            {data.status === 'SUSPENDED' && (
              <Button leftIcon={<Check className="size-3.5" />} onClick={() => setPending('approve')}>
                Reinstate
              </Button>
            )}
          </>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="profile">Profile</Tab>
          <Tab value="documents">Documents</Tab>
          <Tab value="history">History</Tab>
        </TabList>

        <TabPanel value="profile">
          <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
            <Card>
              <CardHeader title="Registration" />
              <CardBody>
                <FieldGrid className="grid-cols-2 sm:grid-cols-2">
                  <Field label="Legal name">{data.legalName ?? '—'}</Field>
                  <Field label="Email">{data.email}</Field>
                  <Field label="Phone">{data.phone ?? '—'}</Field>
                  <Field label="GSTIN">
                    <span className="font-mono">{data.gstin ?? '—'}</span>
                  </Field>
                  <Field label="PAN">
                    <span className="font-mono">{data.pan ?? '—'}</span>
                  </Field>
                  <Field label="GST state code">
                    <span className="font-mono">{data.stateCode}</span>
                  </Field>
                  <Field label="Address" className="col-span-2">
                    {data.addressLine1}
                    {data.addressLine2 && `, ${data.addressLine2}`}
                    <br />
                    {data.city}, {data.state} {data.pincode}
                  </Field>
                  <Field label="Approved at">{formatDate(data.approvedAt)}</Field>
                </FieldGrid>
              </CardBody>
            </Card>

            <Card className="h-fit">
              <CardHeader title="Profile completeness" />
              <CardBody>
                <Completion score={data.completion.score} checks={data.completion.checks} />
              </CardBody>
            </Card>
          </div>
        </TabPanel>

        <TabPanel value="documents">
          <DocumentsTab
            ownerType="ORGANIZATION"
            ownerId={id}
            description="GST certificate and PAN, as uploaded by the organization."
            canUpload={false}
          />
        </TabPanel>

        <TabPanel value="history">
          <HistoryTab entityType="Organization" entityId={id} />
        </TabPanel>
      </Tabs>

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending ? DECISIONS[pending].title : ''}
        message={pending ? DECISIONS[pending].message : ''}
        confirmLabel={pending ? DECISIONS[pending].confirmLabel : 'Confirm'}
        requireReason={pending ? DECISIONS[pending].requireReason : false}
        reasonMinLength={5}
        destructive={pending !== 'approve'}
        loading={decide.isPending}
        onConfirm={(reason) => {
          if (!pending) return;
          decide.mutate(
            {
              action: pending,
              ...(DECISIONS[pending].requireReason ? { reason } : {}),
            },
            {
              onSuccess: () => {
                toast.success(`Organization ${pending === 'approve' ? 'approved' : `${pending}ed`}`);
                setPending(null);
              },
              onError: (error) => toast.fromError(error),
            },
          );
        }}
      />
    </>
  );
}
