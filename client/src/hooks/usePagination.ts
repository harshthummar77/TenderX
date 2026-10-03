import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@tb/shared';

export interface PaginationState {
  page: number;
  limit: number;
  /** Server sort format: `createdAt` or `-createdAt` (00 §6). */
  sort: string | undefined;
  q: string | undefined;
  setPage: (page: number) => void;
  setLimit: (limit: number) => void;
  setSort: (sort: string | undefined) => void;
  setQuery: (q: string | undefined) => void;
  /** Any other filter a list screen owns, e.g. `setFilter('status', 'DRAFT')`. */
  setFilter: (key: string, value: string | undefined) => void;
  getFilter: (key: string) => string | undefined;
  reset: () => void;
  /** Spread straight into an axios `params` object. */
  params: Record<string, string | number>;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * List state lives in the URL, not in component state.
 *
 * That is what makes "page 3 of pending invoices, sorted by due date" a link
 * someone can paste into a message — and it is why the dashboard tiles can deep
 * link straight to `/invoices?matchStatus=EXCEPTION` (plan 15).
 */
export function usePagination(defaults?: { limit?: number; sort?: string }): PaginationState {
  const [searchParams, setSearchParams] = useSearchParams();

  const page = clamp(Number(searchParams.get('page') ?? 1) || 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = clamp(
    Number(searchParams.get('limit') ?? defaults?.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE,
  );
  const sort = searchParams.get('sort') ?? defaults?.sort ?? undefined;
  const q = searchParams.get('q') ?? undefined;

  const patch = useCallback(
    (changes: Record<string, string | undefined>, resetPage = true) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(changes)) {
            if (value === undefined || value === '') next.delete(key);
            else next.set(key, value);
          }
          // Changing a filter while on page 4 of the old result set shows an
          // empty table and looks like a bug; every filter change goes to page 1.
          if (resetPage && !('page' in changes)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setPage = useCallback((value: number) => patch({ page: String(value) }, false), [patch]);
  const setLimit = useCallback((value: number) => patch({ limit: String(value) }), [patch]);
  const setSort = useCallback((value: string | undefined) => patch({ sort: value }), [patch]);
  const setQuery = useCallback((value: string | undefined) => patch({ q: value }), [patch]);
  const setFilter = useCallback(
    (key: string, value: string | undefined) => patch({ [key]: value }),
    [patch],
  );
  const getFilter = useCallback(
    (key: string) => searchParams.get(key) ?? undefined,
    [searchParams],
  );
  const reset = useCallback(() => setSearchParams(new URLSearchParams(), { replace: true }), [
    setSearchParams,
  ]);

  // Every search param reaches the API, so a screen's own filters (status,
  // matchStatus, dateFrom…) need no extra wiring — they are already here.
  const params = useMemo(() => {
    const result: Record<string, string | number> = {};
    for (const [key, value] of searchParams.entries()) {
      if (value !== '') result[key] = value;
    }
    result.page = page;
    result.limit = limit;
    if (sort) result.sort = sort;
    return result;
  }, [searchParams, page, limit, sort]);

  return {
    page,
    limit,
    sort,
    q,
    setPage,
    setLimit,
    setSort,
    setQuery,
    setFilter,
    getFilter,
    reset,
    params,
  };
}
