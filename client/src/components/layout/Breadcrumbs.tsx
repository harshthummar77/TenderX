import { Fragment, type ReactNode } from 'react';
import { Link, useMatches } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface Crumb {
  label: ReactNode;
  to?: string;
}

/** What a route puts in `handle` to appear in the trail. */
export interface RouteHandle {
  crumb?: string | ((data: unknown) => string);
}

/**
 * Breadcrumbs read from route `handle`s, so the trail is declared next to the
 * route rather than assembled by hand on every page:
 *
 *   { path: 'tenders', handle: { crumb: 'Tenders' }, … }
 *
 * A screen with a dynamic title (a tender number) passes `items` explicitly
 * instead — the data for it lives in that screen's query, not in the router.
 */
export function Breadcrumbs({ items, className }: { items?: Crumb[]; className?: string }) {
  const matches = useMatches();

  const crumbs: Crumb[] =
    items ??
    matches
      .filter((match) => !!(match.handle as RouteHandle | undefined)?.crumb)
      .map((match) => {
        const handle = match.handle as RouteHandle;
        return {
          label: typeof handle.crumb === 'function' ? handle.crumb(match.data) : handle.crumb,
          to: match.pathname,
        };
      });

  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn('flex items-center gap-1 text-xs', className)}>
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <Fragment key={`${crumb.to ?? ''}-${index}`}>
            {index > 0 && <ChevronRight aria-hidden className="size-3 text-muted" />}
            {crumb.to && !last ? (
              <Link to={crumb.to} className="text-muted hover:text-text hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current={last ? 'page' : undefined} className="text-muted">
                {crumb.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
