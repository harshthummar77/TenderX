import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A hover/focus tooltip for the things a dense screen cannot spell out: a
 * truncated vendor name, why an action is disabled, what a match exception means.
 *
 * Opens on focus as well as hover, so it is reachable from the keyboard, and it
 * is never the only place a piece of information exists.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {open && content && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'pointer-events-none absolute left-1/2 z-50 w-max max-w-xs -translate-x-1/2 rounded-md',
            'border border-border bg-surface px-2 py-1 text-xs text-text shadow-md',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
