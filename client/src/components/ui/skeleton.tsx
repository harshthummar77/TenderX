import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded bg-subtle', className)} />;
}

/**
 * Table loading state. Rows the size of real rows, so the layout does not jump
 * when the data lands — the alternative, a centred spinner, reflows the whole
 * page on every page change.
 */
export function SkeletonRows({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} className="border-b border-border last:border-0">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <td key={columnIndex} className="px-3 py-2.5">
              <Skeleton className={cn('h-4', columnIndex === 0 ? 'w-40' : 'w-20')} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
