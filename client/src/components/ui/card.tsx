import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface shadow-xs', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-border px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-text">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border bg-subtle px-4 py-3',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A label/value pair. Used on every detail screen, which is why the numeric
 * variant lives here: a figure in a detail panel aligns the same way as a figure
 * in a table (§4).
 */
export function Field({
  label,
  children,
  numeric = false,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('mt-0.5 text-sm text-text', numeric && 'numeric text-left')}>{children}</dd>
    </div>
  );
}

export function FieldGrid({ className, ...props }: HTMLAttributes<HTMLDListElement>) {
  return (
    <dl
      className={cn('grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4', className)}
      {...props}
    />
  );
}
