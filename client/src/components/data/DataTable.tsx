import { useMemo, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Settings2,
} from 'lucide-react';
import { DEFAULT_PAGE_SIZE } from '@tb/shared';
import { cn } from '@/lib/cn';
import { isApiError } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dropdown } from '@/components/ui/dropdown';
import { Select } from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { TBody, THead, TH, TD, TR, Table } from '@/components/ui/table';
import { EmptyState } from '@/components/data/EmptyState';
import '@/types/table';

/**
 * The table ~20 screens use (plan 16 §5). Everything is server-side: the API
 * paginates and sorts (00 §6), so this component never receives more than one
 * page and never sorts in the browser — a client-side sort of page 2 of 7 sorts
 * the wrong 20 rows and is the kind of bug nobody reports, they just stop
 * trusting the numbers.
 *
 * It owns all five states a list can be in — loading, error, empty, loaded, and
 * refetching — because getting that wrong once per screen is twenty bugs.
 */

export interface DataTableProps<T> {
  columns: ColumnDef<T, any>[];
  data: T[] | undefined;

  /* state */
  isLoading?: boolean;
  /** A background refetch: the table stays on screen with a quiet indicator. */
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;

  /* server pagination — omit to render a plain table with no footer */
  page?: number;
  limit?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onLimitChange?: (limit: number) => void;

  /* server sorting, in the API's `-field` form */
  sort?: string;
  onSortChange?: (sort: string | undefined) => void;

  onRowClick?: (row: T) => void;
  getRowId?: (row: T) => string;
  /** Tint a row — a match exception, an overdue invoice. */
  rowClassName?: (row: T) => string | undefined;

  emptyState?: ReactNode;
  stickyHeader?: boolean;
  /** Off for a short embedded table where the gear icon is noise. */
  columnVisibility?: boolean;
  /** Rendered in the footer's left side: bulk actions, a totals line. */
  footerSlot?: ReactNode;
  className?: string;
}

const PAGE_SIZES = [10, 20, 50, 100];

/** `-createdAt` ⇄ `{ id: 'createdAt', desc: true }`. */
const parseSort = (sort: string | undefined) =>
  sort ? { id: sort.replace(/^-/, ''), desc: sort.startsWith('-') } : null;

export function DataTable<T>({
  columns,
  data,
  isLoading = false,
  isFetching = false,
  error,
  onRetry,
  page,
  limit = DEFAULT_PAGE_SIZE,
  total,
  onPageChange,
  onLimitChange,
  sort,
  onSortChange,
  onRowClick,
  getRowId,
  rowClassName,
  emptyState,
  stickyHeader = true,
  columnVisibility = true,
  footerSlot,
  className,
}: DataTableProps<T>) {
  const [hidden, setHidden] = useState<VisibilityState>({});
  const rows = data ?? [];
  const activeSort = useMemo(() => parseSort(sort), [sort]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { columnVisibility: hidden },
    onColumnVisibilityChange: setHidden,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    ...(getRowId ? { getRowId: (row: T) => getRowId(row) } : {}),
  });

  const columnCount = table.getVisibleLeafColumns().length;
  const paginated = page !== undefined && total !== undefined && !!onPageChange;
  const pageCount = paginated ? Math.max(1, Math.ceil(total / limit)) : 1;

  /** asc → desc → unsorted, which is what people expect from a header click. */
  const cycleSort = (columnId: string) => {
    if (!onSortChange) return;
    if (activeSort?.id !== columnId) onSortChange(columnId);
    else if (!activeSort.desc) onSortChange(`-${columnId}`);
    else onSortChange(undefined);
  };

  if (error) {
    const apiError = isApiError(error) ? error : null;
    return (
      <div className={cn('rounded-lg border border-border bg-surface', className)}>
        <EmptyState
          icon={<AlertTriangle className="size-5 text-danger" />}
          title="This list could not be loaded"
          message={
            apiError
              ? `${apiError.message}${apiError.requestId ? ` (reference ${apiError.requestId})` : ''}`
              : 'Something went wrong while fetching these rows.'
          }
          action={
            onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className={cn('rounded-lg border border-border bg-surface', className)}>
      {(columnVisibility || isFetching) && (
        <div className="flex h-9 items-center justify-end gap-2 border-b border-border px-2">
          {isFetching && !isLoading && <Spinner size="sm" label="Refreshing" />}
          {columnVisibility && (
            <Dropdown
              trigger={({ toggle, open, id }) => (
                <Button
                  id={id}
                  variant="ghost"
                  size="sm"
                  onClick={toggle}
                  aria-expanded={open}
                  leftIcon={<Settings2 className="size-3.5" />}
                >
                  Columns
                </Button>
              )}
            >
              {table
                .getAllLeafColumns()
                .filter((column) => column.getCanHide() && !column.columnDef.meta?.alwaysVisible)
                .map((column) => {
                  const header = column.columnDef.header;
                  const label =
                    column.columnDef.meta?.label ??
                    (typeof header === 'string' ? header : column.id);
                  return (
                    <label
                      key={column.id}
                      className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-subtle"
                    >
                      <input
                        type="checkbox"
                        checked={column.getIsVisible()}
                        onChange={column.getToggleVisibilityHandler()}
                        className="accent-primary"
                      />
                      {label}
                    </label>
                  );
                })}
            </Dropdown>
          )}
        </div>
      )}

      <Table>
        <THead sticky={stickyHeader}>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const meta = header.column.columnDef.meta;
                const sortable = !!onSortChange && header.column.columnDef.enableSorting !== false;
                const isSorted = activeSort?.id === header.column.id;
                const SortIcon = !isSorted ? ChevronsUpDown : activeSort.desc ? ChevronDown : ChevronUp;

                return (
                  <TH
                    key={header.id}
                    numeric={meta?.numeric}
                    className={meta?.headerClassName}
                    aria-sort={isSorted ? (activeSort.desc ? 'descending' : 'ascending') : undefined}
                  >
                    {header.isPlaceholder ? null : sortable ? (
                      <button
                        type="button"
                        onClick={() => cycleSort(header.column.id)}
                        className={cn(
                          'inline-flex items-center gap-1 hover:text-text',
                          meta?.numeric && 'flex-row-reverse',
                          isSorted && 'text-text',
                        )}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <SortIcon aria-hidden className="size-3.5 opacity-70" />
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TH>
                );
              })}
            </tr>
          ))}
        </THead>

        <TBody>
          {isLoading ? (
            <SkeletonRows columns={columnCount} />
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount}>
                {emptyState ?? <EmptyState title="Nothing here yet" message="No rows match this view." />}
              </td>
            </tr>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TR
                key={row.id}
                clickable={!!onRowClick}
                className={rowClassName?.(row.original)}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                // A clickable row must also be reachable without a mouse.
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === 'Enter') onRowClick(row.original);
                      }
                    : undefined
                }
              >
                {row.getVisibleCells().map((cell) => (
                  <TD
                    key={cell.id}
                    numeric={cell.column.columnDef.meta?.numeric}
                    className={cell.column.columnDef.meta?.className}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TD>
                ))}
              </TR>
            ))
          )}
        </TBody>
      </Table>

      {(paginated || footerSlot) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2">
          <div className="flex items-center gap-3 text-xs text-muted">
            {paginated && total > 0 && (
              <span>
                {formatCount((page - 1) * limit + 1)}–{formatCount(Math.min(page * limit, total))} of{' '}
                {formatCount(total)}
              </span>
            )}
            {footerSlot}
          </div>

          {paginated && (
            <div className="flex items-center gap-2">
              {onLimitChange && (
                <Select
                  aria-label="Rows per page"
                  value={String(limit)}
                  onChange={(event) => onLimitChange(Number(event.target.value))}
                  className="h-8 w-20 text-xs"
                  options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} / page` }))}
                />
              )}
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
                className="size-8"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="font-mono text-xs tabular-nums text-muted">
                {page} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next page"
                disabled={page >= pageCount}
                onClick={() => onPageChange(page + 1)}
                className="size-8"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
