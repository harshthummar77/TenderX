import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Breadcrumbs, type Crumb } from '@/components/layout/Breadcrumbs';
import { StatusBadge } from '@/components/data/StatusBadge';

/**
 * The top of every screen: trail, title, status, actions. One component, so the
 * twenty-odd screens in plan 17 cannot each invent their own spacing.
 */
export function PageHeader({
  title,
  description,
  status,
  crumbs,
  actions,
  backTo,
  meta,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** An enum value — `StatusBadge` owns the colour. */
  status?: string | null;
  /** Explicit trail for a dynamic title; omit to use the route handles. */
  crumbs?: Crumb[];
  actions?: ReactNode;
  /** A detail screen's "back to list" affordance. */
  backTo?: string;
  /** A line of secondary facts under the title — amount, deadline, vendor. */
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-5', className)}>
      <Breadcrumbs items={crumbs} className="mb-1.5" />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {backTo && (
              <Link
                to={backTo}
                aria-label="Back"
                className="rounded-md p-1 text-muted hover:bg-subtle hover:text-text"
              >
                <ArrowLeft className="size-4" />
              </Link>
            )}
            <h1 className="truncate text-lg font-semibold tracking-tight text-text">{title}</h1>
            {status && <StatusBadge status={status} size="md" />}
          </div>

          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">{meta}</div>}
        </div>

        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
