import type { ReportQuery } from '@tb/shared';

/**
 * The reporting window, shared by all four reports.
 *
 * Defaults to the last twelve months rather than all time: a report with no
 * window is a report that gets slower every month it exists, and "the last
 * year" is what somebody means when they do not say.
 *
 * `to` is pushed to the end of its day, so `to=2025-08-20` includes the
 * twentieth. A half-open window would silently drop the final day and nobody
 * would notice until the totals disagreed with the ledger.
 */
export const DEFAULT_WINDOW_MONTHS = 12;

export function reportWindow(query: Pick<ReportQuery, 'from' | 'to'>): {
  from: Date;
  to: Date;
} {
  const to = query.to ? endOfDay(new Date(query.to)) : endOfDay(new Date());

  const from = query.from
    ? startOfDay(new Date(query.from))
    : startOfDay(monthsBefore(to, DEFAULT_WINDOW_MONTHS));

  // A reversed window returns nothing rather than throwing: a date picker that
  // briefly holds an invalid range should not produce an error page.
  return from > to ? { from: to, to } : { from, to };
}

const startOfDay = (date: Date): Date => {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
};

const endOfDay = (date: Date): Date => {
  const copy = new Date(date);
  copy.setUTCHours(23, 59, 59, 999);
  return copy;
};

const monthsBefore = (date: Date, months: number): Date => {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
};
