import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * The empty state is part of the feature, not an afterthought: "No tenders yet —
 * create your first one" teaches the screen, while a blank table reads as broken.
 */
export function EmptyState({
  icon,
  title,
  message,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  message?: string;
  /** The primary thing to do next — usually a `<ButtonLink>`. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-12 text-center', className)}>
      <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-subtle text-muted">
        {icon ?? <Inbox className="size-5" />}
      </div>
      <p className="text-sm font-medium text-text">{title}</p>
      {message && <p className="mt-1 max-w-sm text-xs text-muted">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
