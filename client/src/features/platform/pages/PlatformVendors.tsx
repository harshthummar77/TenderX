import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, Ban, Check, Pause, Play, Store, X } from 'lucide-react';
import {
  PERMISSIONS as P,
  VENDOR_STATUSES,
  type VendorPublicDto,
} from '@tb/shared';
import { formatCount, formatDate, humanize } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { usePagination } from '@/hooks/usePagination';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { MissingKycList } from '@/components/data/Completion';
import { StatusBadge } from '@/components/data/StatusBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import { usePlatformVendor, usePlatformVendors, useVendorDecision } from '@/features/vendors/api';

/** `/platform/vendors` — every vendor on the platform, in any state. */
export function PlatformVendorsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const pagination = usePagination({ sort: '-createdAt' });

  /**
   * `listVendors` defaults to `status: APPROVED` when the query carries no
   * status — sensible for the buyer's directory, wrong for a review queue, which
   * exists precisely to show the vendors that are NOT approved yet. So this
   * screen always sends an explicit status and offers no "any" option: an "Any
   * status" that silently meant "approved only" would be a lie.
   */
  const status = pagination.getFilter('status') ?? 'PENDING_APPROVAL';
  const vendors = usePlatformVendors({ ...pagination.params, status });

  const columns = useMemo<ColumnDef<VendorPublicDto, any>[]>(
    () => [
      {
        id: 'companyName',
        header: 'Vendor',
        accessorKey: 'companyName',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.companyName}</p>
            <p className="truncate text-xs text-muted">{row.original.email}</p>
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
        id: 'location',
        header: 'Location',
        enableSorting: false,
        cell: ({ row }) => `${row.original.city}, ${row.original.state}`,
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
      },
      {
        id: 'totalOrders',
        header: 'Orders',
        accessorKey: 'totalOrders',
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

  if (!can(P.VENDOR_VIEW)) return <Forbidden />;

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Every vendor on the platform. Approving one lets buyers invite it to tenders."
      />

      <FilterBar
        search={pagination.q}
        onSearchChange={pagination.setQuery}
        searchPlaceholder="Search name, GSTIN or email…"
        onClear={pagination.reset}
        activeCount={pagination.getFilter('status') ? 1 : 0}
      >
        <Select
          aria-label="Status"
          className="h-9 w-48"
          value={status}
          options={VENDOR_STATUSES.map((value) => ({ value, label: humanize(value) }))}
          onChange={(event) => pagination.setFilter('status', event.target.value)}
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
        onRowClick={(row) => navigate(`/platform/vendors/${row.id}`)}
        emptyState={
          <EmptyState
            icon={<Store className="size-5" />}
            title="No vendors yet"
            message="Vendors appear here as soon as they register."
          />
        }
      />
    </>
  );
}

type VendorAction = 'approve' | 'reject' | 'suspend' | 'reinstate' | 'blacklist';

const ACTION_COPY: Record<
  VendorAction,
  { title: string; message: string; confirmLabel: string; requireReason: boolean }
> = {
  approve: {
    title: 'Approve this vendor?',
    message: 'They will be able to bid on tenders they are invited to.',
    confirmLabel: 'Approve',
    requireReason: false,
  },
  reject: {
    title: 'Reject this vendor?',
    message: 'They are told why and can correct the problem and re-apply.',
    confirmLabel: 'Reject',
    requireReason: true,
  },
  suspend: {
    title: 'Suspend this vendor?',
    message:
      'Existing orders continue, but they cannot bid or start new business until reinstated.',
    confirmLabel: 'Suspend',
    requireReason: true,
  },
  reinstate: {
    title: 'Reinstate this vendor?',
    message: 'They can bid again immediately.',
    confirmLabel: 'Reinstate',
    requireReason: false,
  },
  blacklist: {
    title: 'Blacklist this vendor?',
    message:
      'This is irreversible — the state machine has no way out of BLACKLISTED. They can never bid or be awarded work again.',
    confirmLabel: 'Blacklist permanently',
    requireReason: true,
  },
};

/** `/platform/vendors/:id` — the review screen: KYC, duplicates, documents. */
export function PlatformVendorReviewPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('review');
  const vendor = usePlatformVendor(id);
  const decide = useVendorDecision(id);
  const [pending, setPending] = useState<VendorAction | null>(null);

  if (!can(P.VENDOR_VIEW)) return <Forbidden />;

  if (vendor.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!vendor.data) return <EmptyState title="Vendor not found" />;

  const data = vendor.data;
  const canApprove = can(P.VENDOR_APPROVE);
  const canBlacklist = can(P.VENDOR_BLACKLIST);
  const readyToApprove = data.missingKyc.length === 0;

  return (
    <>
      <PageHeader
        title={data.companyName}
        status={data.status}
        backTo="/platform/vendors"
        crumbs={[{ label: 'Vendors', to: '/platform/vendors' }, { label: data.companyName }]}
        meta={
          <>
            <span className="font-mono">{data.gstin ?? 'No GSTIN'}</span>
            <span>
              {data.city}, {data.state}
            </span>
            <span>{formatCount(data.userCount)} users</span>
            <span>Registered {formatDate(data.createdAt)}</span>
          </>
        }
        actions={
          <>
            {canApprove && data.status === 'PENDING_APPROVAL' && (
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
                  disabled={!readyToApprove}
                  title={
                    readyToApprove ? undefined : 'KYC is incomplete — see the checklist below.'
                  }
                  onClick={() => setPending('approve')}
                >
                  Approve
                </Button>
              </>
            )}
            {canApprove && data.status === 'APPROVED' && (
              <Button
                variant="outline"
                leftIcon={<Pause className="size-3.5" />}
                onClick={() => setPending('suspend')}
              >
                Suspend
              </Button>
            )}
            {canApprove && (data.status === 'SUSPENDED' || data.status === 'REJECTED') && (
              <Button
                variant="outline"
                leftIcon={<Play className="size-3.5" />}
                onClick={() => setPending('reinstate')}
              >
                Reinstate
              </Button>
            )}
            {canBlacklist && data.status !== 'BLACKLISTED' && (
              <Button
                variant="danger"
                leftIcon={<Ban className="size-3.5" />}
                onClick={() => setPending('blacklist')}
              >
                Blacklist
              </Button>
            )}
          </>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="review">Review</Tab>
          <Tab value="documents" count={data.documents.length}>
            Documents
          </Tab>
          <Tab value="history">History</Tab>
        </TabList>

        <TabPanel value="review">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="space-y-4">
              <Card>
                <CardHeader title="Company" />
                <CardBody>
                  <FieldGrid className="grid-cols-2 sm:grid-cols-2">
                    <Field label="Legal name">{data.legalName ?? '—'}</Field>
                    <Field label="Email">{data.email}</Field>
                    <Field label="Phone">{data.phone}</Field>
                    <Field label="PAN">
                      <span className="font-mono">{data.pan ?? '—'}</span>
                    </Field>
                    <Field label="Address" className="col-span-2">
                      {data.addressLine1}
                      {data.addressLine2 && `, ${data.addressLine2}`}
                      <br />
                      {data.city}, {data.state} {data.pincode}
                    </Field>
                  </FieldGrid>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Bank details"
                  description="Masked — only the last four digits ever leave the server."
                />
                <CardBody>
                  <FieldGrid className="grid-cols-2 sm:grid-cols-2">
                    <Field label="Bank">{data.bankName ?? '—'}</Field>
                    <Field label="Account holder">{data.bankAccountName ?? '—'}</Field>
                    <Field label="Account number">
                      <span className="font-mono">{data.bankAccountNumber ?? '—'}</span>
                    </Field>
                    <Field label="IFSC">
                      <span className="font-mono">{data.bankIfsc ?? '—'}</span>
                    </Field>
                  </FieldGrid>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Categories" />
                <CardBody>
                  {data.categories.length === 0 ? (
                    <p className="text-xs text-muted">None selected.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {data.categories.map((category) => (
                        <Badge key={category.id} size="md">
                          {category.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardHeader title="KYC checklist" />
                <CardBody>
                  <MissingKycList missing={data.missingKyc} />
                </CardBody>
              </Card>

              {data.duplicateWarnings.length > 0 && (
                <Card className="border-warning/40">
                  <CardHeader
                    title="Possible duplicates"
                    description="Surfaced, never blocking — you decide."
                  />
                  <CardBody>
                    <ul className="space-y-2">
                      {data.duplicateWarnings.map((warning) => (
                        <li
                          key={`${warning.kind}-${warning.vendorId}`}
                          className="flex items-start gap-2 text-xs"
                        >
                          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                          <span>
                            {warning.message}
                            <span className="block text-muted">{warning.vendorName}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              )}

              {data.statusReason && (
                <Card>
                  <CardHeader title="Last decision" />
                  <CardBody>
                    <p className="text-xs text-muted">{data.statusReason}</p>
                  </CardBody>
                </Card>
              )}
            </div>
          </div>
        </TabPanel>

        <TabPanel value="documents">
          <DocumentsTab ownerType="VENDOR" ownerId={id} canUpload={false} />
        </TabPanel>

        <TabPanel value="history">
          <HistoryTab entityType="Vendor" entityId={id} />
        </TabPanel>
      </Tabs>

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending ? ACTION_COPY[pending].title : ''}
        message={pending ? ACTION_COPY[pending].message : ''}
        confirmLabel={pending ? ACTION_COPY[pending].confirmLabel : 'Confirm'}
        requireReason={pending ? ACTION_COPY[pending].requireReason : false}
        reasonMinLength={5}
        destructive={pending !== 'approve' && pending !== 'reinstate'}
        loading={decide.isPending}
        onConfirm={(reason) => {
          if (!pending) return;
          decide.mutate(
            { action: pending, ...(ACTION_COPY[pending].requireReason ? { reason } : {}) },
            {
              onSuccess: () => {
                toast.success('Vendor updated');
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
