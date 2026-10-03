import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Table primitives. `DataTable` is built on these, and a screen that needs a
 * small static table (a PO's line items, a comparison matrix) uses them directly
 * instead of paying for TanStack Table.
 */

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  );
}

export function THead({
  sticky = false,
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }) {
  return (
    <thead
      className={cn(
        'bg-subtle text-xs text-muted',
        // A 40-row table is useless if the headers scroll away.
        sticky && 'sticky top-0 z-10 shadow-[inset_0_-1px_0_var(--color-border-strong)]',
        className,
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-border', className)} {...props} />;
}

export function TFoot({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tfoot
      className={cn('border-t-2 border-border-strong bg-subtle font-medium', className)}
      {...props}
    />
  );
}

export function TR({
  clickable = false,
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { clickable?: boolean }) {
  return (
    <tr
      className={cn(
        'border-b border-border last:border-0',
        clickable && 'cursor-pointer hover:bg-subtle',
        className,
      )}
      {...props}
    />
  );
}

export function TH({
  numeric = false,
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left font-medium whitespace-nowrap',
        numeric && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  numeric = false,
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        'px-3 py-2.5 align-middle',
        // The money rule, in one place (§4): mono, tabular, right-aligned.
        numeric && 'numeric',
        className,
      )}
      {...props}
    />
  );
}
