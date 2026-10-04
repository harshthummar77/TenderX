import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import {
  PERMISSIONS as P,
  SPEND_GROUP_BY,
  type ReportColumn,
  type ReportResponse,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import { apiDownload, apiGet } from '@/lib/api';
import { formatCount, formatDate, formatMoney, formatPercent } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { usePagination } from '@/hooks/usePagination';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TFoot, TH, THead, TR, Table } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { qk } from '@/lib/queryKeys';

/**
 * `/reports` — four reports, one renderer (plan 15).
 *
 * The column list travels with the data, so this table can render a report it
 * has never seen: `type` on each column says how to align and format it, which
 * is what keeps money right-aligned and monospaced without the client knowing
 * anything about spend analysis.
 */

const REPORTS = [
  { key: 'spend', label: 'Spend', path: '/reports/spend' },
  { key: 'tenders', label: 'Tenders', path: '/reports/tenders' },
  { key: 'vendors', label: 'Vendor performance', path: '/reports/vendor-performance' },
  { key: 'exceptions', label: 'Match exceptions', path: '/reports/match-exceptions' },
] as const;

type ReportKey = (typeof REPORTS)[number]['key'];

/** One formatter per column type — the whole reason the type travels with the data. */
function renderCell(column: ReportColumn, value: string | number | null) {
  if (value === null || value === '') return <span className="text-muted">—</span>;

  switch (column.type) {
    case 'money':
      return formatMoney(String(value));
    case 'percent':
      return formatPercent(value, 1);
    case 'number':
      return formatCount(Number(value));
    case 'date':
      return formatDate(String(value));
    default:
      return String(value);
  }
}

const isNumeric = (column: ReportColumn) =>
  column.type === 'money' || column.type === 'number' || column.type === 'percent';

export function ReportsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('spend');
  const pagination = usePagination();

  const active = REPORTS.find((report) => report.key === tab) ?? REPORTS[0];
  const from = pagination.getFilter('from');
  const to = pagination.getFilter('to');
  const groupBy = pagination.getFilter('groupBy') ?? 'category';

  const params = useMemo(() => {
    const query: Record<string, string> = {};
    if (from) query.from = from;
    if (to) query.to = to;
    if (active.key === 'spend') query.groupBy = groupBy;
    return query;
  }, [from, to, groupBy, active.key]);

  const report = useQuery<ReportResponse>({
    queryKey: [...qk.reports.all, active.key, params] as const,
    queryFn: () => apiGet<ReportResponse>(active.path, { params }),
    enabled: can(P.REPORT_VIEW),
  });

  if (!can(P.REPORT_VIEW)) return <Forbidden />;

  const exportCsv = async () => {
    try {
      const blob = await apiDownload(active.path, { params: { ...params, format: 'csv' } });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${active.key}-report.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.fromError(error);
    }
  };

  const columns = report.data?.columns ?? [];
  const rows = report.data?.rows ?? [];
  const totals = report.data?.totals ?? {};
  const hasTotals = Object.keys(totals).length > 0;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Spend, sourcing, vendor performance and match exceptions."
        actions={
          <Button
            variant="outline"
            leftIcon={<Download className="size-3.5" />}
            disabled={rows.length === 0}
            onClick={() => void exportCsv()}
          >
            Export CSV
          </Button>
        }
      />

      <div
        role="tablist"
        aria-label="Report"
        className="mb-4 flex flex-wrap gap-1 border-b border-border"
      >
        {REPORTS.map((item) => (
          <button
            key={item.key}
            role="tab"
            type="button"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key as ReportKey)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === item.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted hover:text-text',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <FilterBar
        onClear={pagination.reset}
        activeCount={['from', 'to', 'groupBy'].filter((key) => !!pagination.getFilter(key)).length}
      >
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted" htmlFor="report-from">
            From
          </label>
          <Input
            id="report-from"
            type="date"
            className="h-9 w-40"
            value={from ?? ''}
            onChange={(event) => pagination.setFilter('from', event.target.value || undefined)}
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-muted" htmlFor="report-to">
            To
          </label>
          <Input
            id="report-to"
            type="date"
            className="h-9 w-40"
            value={to ?? ''}
            onChange={(event) => pagination.setFilter('to', event.target.value || undefined)}
          />
        </div>

        {active.key === 'spend' && (
          <Select
            aria-label="Group by"
            className="h-9 w-40"
            value={groupBy}
            options={SPEND_GROUP_BY.map((value) => ({
              value,
              label: `By ${value}`,
            }))}
            onChange={(event) => pagination.setFilter('groupBy', event.target.value)}
          />
        )}
      </FilterBar>

      <Card>
        <CardHeader
          title={active.label}
          description={
            report.data
              ? `${formatCount(report.data.meta.rowCount)} rows · generated ${formatDate(report.data.meta.generatedAt)}`
              : undefined
          }
        />

        {report.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-48 w-full" />
          </div>
        ) : report.isError ? (
          <EmptyState
            icon={<FileText className="size-5 text-danger" />}
            title="This report could not be generated"
            message="Try a narrower date range."
            action={
              <Button variant="outline" size="sm" onClick={() => report.refetch()}>
                Try again
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title="No data in this window"
            message="Widen the date range, or come back once there is activity to report on."
          />
        ) : (
          <Table>
            <THead sticky>
              <tr>
                {columns.map((column) => (
                  <TH key={column.key} numeric={isNumeric(column)}>
                    {column.label}
                  </TH>
                ))}
              </tr>
            </THead>
            <TBody>
              {rows.map((row, index) => (
                <TR key={index}>
                  {columns.map((column) => (
                    <TD key={column.key} numeric={isNumeric(column)}>
                      {renderCell(column, row[column.key] ?? null)}
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>

            {hasTotals && (
              <TFoot>
                <tr>
                  {columns.map((column, index) => (
                    <TD key={column.key} numeric={isNumeric(column)}>
                      {index === 0 && totals[column.key] === undefined
                        ? 'Total'
                        : totals[column.key] === undefined
                          ? ''
                          : renderCell(column, totals[column.key] ?? null)}
                    </TD>
                  ))}
                </tr>
              </TFoot>
            )}
          </Table>
        )}
      </Card>
    </>
  );
}
