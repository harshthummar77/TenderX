import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Check, ClipboardCheck, Info, X } from 'lucide-react';
import {
  APPROVAL_ENTITIES,
  APPROVAL_STATUSES,
  PERMISSIONS as P,
  REJECTION_COMMENT_MIN_LENGTH,
  type ApprovalDto,
} from '@tb/shared';
import { formatDateTime, formatMoney, formatRelative, humanize } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { usePagination } from '@/hooks/usePagination';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { useApproval, useApprovals, useDecideApproval } from '@/features/evaluation/api';

/**
 * `/approvals` — the queue of decisions waiting on an administrator.
 *
 * `ORG_OFFICER` holds no `APPROVAL_DECIDE`, so this route renders `<Forbidden />`
 * for them in place, with the sidebar intact. That is separation of duties made
 * visible: the officer runs the process, the admin authorises the money, and one
 * person can never take a purchase from tender to payment alone (04 §7).
 */
export function ApprovalListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const pagination = usePagination({ sort: '-requestedAt' });
  const approvals = useApprovals({ ...pagination.params });

  const columns = useMemo<ColumnDef<ApprovalDto, any>[]>(
    () => [
      {
        id: 'entityType',
        header: 'What',
        accessorKey: 'entityType',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{humanize(row.original.entityType)}</p>
            <p className="text-xs text-muted">{formatRelative(row.original.requestedAt)}</p>
          </div>
        ),
      },
      {
        id: 'amount',
        header: 'Amount',
        accessorKey: 'amount',
        meta: { numeric: true },
        cell: ({ getValue }) => {
          const value = getValue() as string | null;
          return value ? formatMoney(value) : '—';
        },
      },
      {
        id: 'requestedBy',
        header: 'Requested by',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate text-sm">{row.original.requestedBy?.name ?? 'System'}</p>
            <p className="truncate text-xs text-muted">{row.original.requestedBy?.email}</p>
          </div>
        ),
      },
      {
        id: 'requestNote',
        header: 'Note',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.requestNote ? (
            <Tooltip content={row.original.requestNote}>
              <span className="line-clamp-1 max-w-xs text-xs text-muted">
                {row.original.requestNote}
              </span>
            </Tooltip>
          ) : (
            <span className="text-xs text-muted">—</span>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <StatusBadge status={row.original.status} />
            {row.original.status === 'PENDING' && !row.original.canDecide && (
              <Tooltip content={row.original.blockedReason ?? 'You cannot decide this one.'}>
                <Info aria-hidden className="size-3.5 text-muted" />
              </Tooltip>
            )}
          </span>
        ),
      },
    ],
    [],
  );

  if (!can(P.APPROVAL_DECIDE)) return <Forbidden />;

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Awards, invoices and payments waiting on a second person."
      />

      <FilterBar
        onClear={pagination.reset}
        activeCount={
          ['status', 'entityType'].filter((key) => pagination.getFilter(key) !== undefined).length
        }
      >
        <Select
          aria-label="Status"
          className="h-9 w-40"
          placeholder="Any status"
          value={pagination.getFilter('status') ?? ''}
          options={APPROVAL_STATUSES.map((status) => ({ value: status, label: humanize(status) }))}
          onChange={(event) => pagination.setFilter('status', event.target.value || undefined)}
        />
        <Select
          aria-label="Type"
          className="h-9 w-44"
          placeholder="Any type"
          value={pagination.getFilter('entityType') ?? ''}
          options={APPROVAL_ENTITIES.map((entity) => ({ value: entity, label: humanize(entity) }))}
          onChange={(event) => pagination.setFilter('entityType', event.target.value || undefined)}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        data={approvals.data?.data}
        isLoading={approvals.isLoading}
        isFetching={approvals.isFetching}
        error={approvals.error}
        onRetry={() => approvals.refetch()}
        page={pagination.page}
        limit={pagination.limit}
        total={approvals.data?.meta.total}
        onPageChange={pagination.setPage}
        onLimitChange={pagination.setLimit}
        sort={pagination.sort}
        onSortChange={pagination.setSort}
        getRowId={(row) => row.id}
        onRowClick={(row) => navigate(`/approvals/${row.id}`)}
        emptyState={
          <EmptyState
            icon={<ClipboardCheck className="size-5" />}
            title="Nothing waiting"
            message="Awards, invoices and payments above your organization's threshold appear here."
          />
        }
      />
    </>
  );
}

/** `/approvals/:id` — the decision screen, with enough of the subject to decide. */
export function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const approval = useApproval(id);
  const decide = useDecideApproval(id);
  const [deciding, setDeciding] = useState<'APPROVED' | 'REJECTED' | null>(null);

  if (!can(P.APPROVAL_DECIDE)) return <Forbidden />;

  if (approval.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!approval.data) return <EmptyState title="Approval not found" />;

  const data = approval.data;
  const pending = data.status === 'PENDING';

  return (
    <>
      <PageHeader
        title={`${humanize(data.entityType)} approval`}
        status={data.status}
        backTo="/approvals"
        crumbs={[{ label: 'Approvals', to: '/approvals' }, { label: humanize(data.entityType) }]}
        meta={
          <>
            {data.amount && (
              <span className="font-mono tabular-nums">{formatMoney(data.amount)}</span>
            )}
            <span>Requested {formatDateTime(data.requestedAt)}</span>
            {data.requestedBy && <span>by {data.requestedBy.name}</span>}
          </>
        }
        actions={
          pending && (
            <>
              <Button
                variant="outline"
                leftIcon={<X className="size-3.5" />}
                disabled={!data.canDecide}
                onClick={() => setDeciding('REJECTED')}
              >
                Reject
              </Button>
              <Button
                leftIcon={<Check className="size-3.5" />}
                disabled={!data.canDecide}
                onClick={() => setDeciding('APPROVED')}
              >
                Approve
              </Button>
            </>
          )
        }
      />

      {pending && !data.canDecide && (
        <Card className="mb-4 border-warning/40 bg-warning/5">
          <CardBody className="flex items-start gap-3 py-3">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-medium">You cannot decide this request</p>
              <p className="text-xs text-muted">
                {data.blockedReason ??
                  'Somebody other than the requester has to sign this off — that is the point of the step.'}
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {data.tender && (
            <Card>
              <CardHeader
                title="Tender"
                description={data.tender.referenceNumber ?? undefined}
                actions={
                  <ButtonLink to={`/tenders/${data.tender.id}`} variant="outline" size="sm">
                    Open tender
                  </ButtonLink>
                }
              />
              <CardBody>
                <p className="mb-3 text-sm font-medium">{data.tender.title}</p>
                <FieldGrid className="grid-cols-2 sm:grid-cols-3">
                  <Field label="Status">
                    <StatusBadge status={data.tender.status} />
                  </Field>
                  <Field label="Estimated budget" numeric>
                    {data.tender.estimatedBudget ? formatMoney(data.tender.estimatedBudget) : '—'}
                  </Field>
                </FieldGrid>

                {data.tender.recommendationNote && (
                  <div className="mt-4 rounded-md border border-border bg-subtle px-3 py-2">
                    <p className="text-xs font-medium">The officer's justification</p>
                    <p className="mt-0.5 text-xs whitespace-pre-wrap text-muted">
                      {data.tender.recommendationNote}
                    </p>
                  </div>
                )}
              </CardBody>
            </Card>
          )}

          {data.quotation && (
            <Card>
              <CardHeader
                title="Recommended bid"
                description={data.quotation.referenceNumber ?? undefined}
                actions={
                  <ButtonLink
                    to={`/quotations/${data.quotation.id}`}
                    variant="outline"
                    size="sm"
                  >
                    Open bid
                  </ButtonLink>
                }
              />
              <CardBody>
                <FieldGrid className="grid-cols-2 sm:grid-cols-3">
                  <Field label="Vendor">{data.quotation.vendorName}</Field>
                  <Field label="Grand total" numeric>
                    {formatMoney(data.quotation.grandTotal)}
                  </Field>
                  <Field label="Delivery" numeric>
                    {data.quotation.deliveryDays} days
                  </Field>
                  <Field label="Score" numeric>
                    {data.quotation.totalScore ?? '—'}
                  </Field>
                  <Field label="Rank" numeric>
                    {data.quotation.rank === null ? '—' : `#${data.quotation.rank}`}
                  </Field>
                </FieldGrid>

                {data.quotation.rank !== null && data.quotation.rank > 1 && (
                  <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
                    This is not the top-ranked bid. The justification above is the officer's case for
                    it — approving makes that your decision too.
                  </p>
                )}
              </CardBody>
            </Card>
          )}

          {!data.tender && !data.quotation && (
            <Card>
              <CardHeader title={humanize(data.entityType)} />
              <CardBody>
                <p className="text-sm text-muted">
                  This request is for a {humanize(data.entityType).toLowerCase()}.{' '}
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() =>
                      navigate(
                        data.entityType === 'INVOICE'
                          ? `/invoices/${data.entityId}`
                          : `/payments/${data.entityId}`,
                      )
                    }
                  >
                    Open it
                  </button>{' '}
                  to see the detail before deciding.
                </p>
              </CardBody>
            </Card>
          )}

          <HistoryTab entityType="Approval" entityId={id} />
        </div>

        <Card className="h-fit">
          <CardHeader title="Request" />
          <CardBody>
            <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
              <Field label="Requested by">
                {data.requestedBy?.name ?? 'System'}
                {data.requestedBy && (
                  <span className="block text-xs text-muted">{data.requestedBy.email}</span>
                )}
              </Field>
              <Field label="Requested at">{formatDateTime(data.requestedAt)}</Field>
              {data.requestNote && <Field label="Note">{data.requestNote}</Field>}

              {data.decidedAt && (
                <>
                  <Field label="Decided by">
                    {data.decidedBy?.name ?? 'System'}
                    {data.decidedBy && (
                      <span className="block text-xs text-muted">{data.decidedBy.email}</span>
                    )}
                  </Field>
                  <Field label="Decided at">{formatDateTime(data.decidedAt)}</Field>
                  {data.decisionComment && <Field label="Comment">{data.decisionComment}</Field>}
                </>
              )}
            </FieldGrid>
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={!!deciding}
        onClose={() => setDeciding(null)}
        title={deciding === 'APPROVED' ? 'Approve this request?' : 'Reject this request?'}
        message={
          deciding === 'APPROVED'
            ? data.entityType === 'TENDER_AWARD'
              ? 'The tender is awarded and a purchase order is generated for the winning vendor in the same transaction.'
              : 'This releases the next step in the process.'
            : 'The requester is told why and can correct the problem and ask again.'
        }
        confirmLabel={deciding === 'APPROVED' ? 'Approve' : 'Reject'}
        requireReason={deciding === 'REJECTED'}
        reasonLabel="Reason"
        reasonMinLength={REJECTION_COMMENT_MIN_LENGTH}
        destructive={deciding === 'REJECTED'}
        loading={decide.isPending}
        onConfirm={(reason) => {
          if (!deciding) return;
          decide.mutate(
            {
              decision: deciding,
              ...(deciding === 'REJECTED' ? { comment: reason } : {}),
            },
            {
              onSuccess: () => {
                toast.success(deciding === 'APPROVED' ? 'Approved' : 'Rejected');
                setDeciding(null);
              },
              onError: (error) => toast.fromError(error),
            },
          );
        }}
      />
    </>
  );
}
