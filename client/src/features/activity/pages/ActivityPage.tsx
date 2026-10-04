import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { AUDIT_SEVERITIES, PERMISSIONS as P } from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatCount, humanize } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { usePagination } from '@/hooks/usePagination';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Timeline } from '@/components/Timeline';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { useActivity, usePlatformActivity, useVerifyChain } from '@/features/activity/api';

/**
 * `/activity` and `/platform/activity` — the audit trail (plan 14 §C).
 *
 * The platform view adds chain verification: it recomputes every row's hash and
 * names the first one that does not reproduce. It is a read, so it is safe to
 * run live on stage — and being able to run it is the point, because an audit log
 * nobody can check is a log nobody should trust.
 */
export function ActivityPage({ scope = 'org' }: { scope?: 'org' | 'platform' }) {
  const { can } = useAuth();
  const pagination = usePagination({ sort: '-createdAt' });
  const [verifying, setVerifying] = useState(false);

  const isPlatform = scope === 'platform';
  const orgActivity = useActivity(pagination.params);
  const platformActivity = usePlatformActivity(pagination.params);
  const activity = isPlatform ? platformActivity : orgActivity;
  const verification = useVerifyChain(isPlatform && verifying);

  if (!can(P.AUDIT_VIEW)) return <Forbidden />;

  const rows = activity.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={isPlatform ? 'Audit log' : 'Activity'}
        description={
          isPlatform
            ? 'Every recorded action across the platform, hash-chained so tampering is detectable.'
            : 'Everything that has happened in your organization.'
        }
        actions={
          isPlatform && (
            <Button
              variant="outline"
              loading={verification.isFetching}
              onClick={() => {
                setVerifying(true);
                void verification.refetch();
              }}
            >
              Verify chain
            </Button>
          )
        }
      />

      {isPlatform && verifying && verification.data && (
        <Card
          className={cn(
            'mb-4',
            verification.data.valid ? 'border-success/40 bg-success/5' : 'border-danger/40 bg-danger/5',
          )}
        >
          <CardBody className="py-3">
            <p className="text-sm font-medium">
              {verification.data.valid ? 'Chain verified' : 'Chain is broken'}
            </p>
            <p className="text-xs text-muted">
              {formatCount(verification.data.rowsChecked)} rows recomputed in{' '}
              {verification.data.durationMs} ms
              {verification.data.firstInvalidSequence &&
                ` · first mismatch at sequence ${verification.data.firstInvalidSequence}`}
              .
            </p>
          </CardBody>
        </Card>
      )}

      <FilterBar
        search={pagination.q}
        onSearchChange={pagination.setQuery}
        searchPlaceholder="Search the summary…"
        onClear={pagination.reset}
        activeCount={
          ['severity', 'entityType', 'action'].filter(
            (key) => pagination.getFilter(key) !== undefined,
          ).length
        }
      >
        <Select
          aria-label="Severity"
          className="h-9 w-40"
          placeholder="Any severity"
          value={pagination.getFilter('severity') ?? ''}
          options={AUDIT_SEVERITIES.map((severity) => ({
            value: severity,
            label: humanize(severity),
          }))}
          onChange={(event) => pagination.setFilter('severity', event.target.value || undefined)}
        />

        <Select
          aria-label="Entity"
          className="h-9 w-44"
          placeholder="Any record type"
          value={pagination.getFilter('entityType') ?? ''}
          options={[
            'Tender',
            'Quotation',
            'PurchaseOrder',
            'Grn',
            'Delivery',
            'Invoice',
            'Payment',
            'Approval',
            'Vendor',
            'Organization',
            'User',
            'Document',
          ].map((entity) => ({ value: entity, label: humanize(entity) }))}
          onChange={(event) => pagination.setFilter('entityType', event.target.value || undefined)}
        />
      </FilterBar>

      <Card>
        <CardHeader
          title="Trail"
          description={
            activity.data ? `${formatCount(activity.data.meta.total)} recorded actions` : undefined
          }
        />
        <CardBody>
          {rows.length === 0 && !activity.isLoading ? (
            <EmptyState
              title="Nothing recorded yet"
              message="Actions appear here as people use the system."
            />
          ) : (
            <Timeline entries={rows} isLoading={activity.isLoading} />
          )}
        </CardBody>
      </Card>

      {(activity.data?.meta.pages ?? 1) > 1 && (
        <div className="mt-3 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page <= 1}
            onClick={() => pagination.setPage(pagination.page - 1)}
          >
            Previous
          </Button>
          <span className="font-mono text-xs tabular-nums text-muted">
            {pagination.page} / {activity.data?.meta.pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page >= (activity.data?.meta.pages ?? 1)}
            onClick={() => pagination.setPage(pagination.page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}

/** `/platform/activity` */
export const PlatformActivityPage = () => <ActivityPage scope="platform" />;

/** `/activity/:entityType/:entityId` — one record's trail, linked from anywhere. */
export function EntityActivityPage() {
  const { entityType, entityId } = useParams<{ entityType: string; entityId: string }>();
  const { can } = useAuth();
  const activity = useActivity({ entityType: entityType ?? '', entityId: entityId ?? '', limit: 100 });

  if (!can(P.AUDIT_VIEW)) return <Forbidden />;

  return (
    <>
      <PageHeader
        title={`${humanize(entityType)} history`}
        description="Every recorded action on this record, with the before and after of each change."
      />

      <Card>
        <CardBody>
          <Timeline entries={activity.data?.data} isLoading={activity.isLoading} />
        </CardBody>
      </Card>
    </>
  );
}
