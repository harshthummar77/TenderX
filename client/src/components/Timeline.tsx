import { useState } from 'react';
import { ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import type { ActivityDto } from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative, humanize, initials } from '@/lib/format';
import { TONE_DOT, type Tone } from '@/components/ui/badge';
import { EmptyState } from '@/components/data/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The activity feed behind every "History" tab (plan 16 §5), rendering the audit
 * rows from plan 14 §C.
 *
 * The expandable before/after diff is the point: "Priya changed this" is trivia,
 * "Priya changed the award from Vendor B to Vendor A" is the audit trail, and on
 * a hash-chained log (plan 14) it is also evidence.
 */

const SEVERITY_TONE: Record<string, Tone> = {
  INFO: 'neutral',
  NOTABLE: 'info',
  SECURITY: 'danger',
};

interface DiffRow {
  field: string;
  before: unknown;
  after: unknown;
}

const render = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/** Only the fields that actually moved — a 30-column dump is not a diff. */
function diffOf(before: unknown, after: unknown): DiffRow[] {
  const left = (before ?? {}) as Record<string, unknown>;
  const right = (after ?? {}) as Record<string, unknown>;
  if (typeof left !== 'object' || typeof right !== 'object') return [];

  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys
    .filter((key) => render(left[key]) !== render(right[key]))
    .map((key) => ({ field: key, before: left[key], after: right[key] }));
}

function TimelineEntry({ entry }: { entry: ActivityDto }) {
  const [open, setOpen] = useState(false);
  const diff = diffOf(entry.before, entry.after);
  const tone = SEVERITY_TONE[entry.severity] ?? 'neutral';

  return (
    <li className="relative pb-5 pl-9 last:pb-0">
      {/* The rail, drawn per entry so the last one does not trail off. */}
      <span aria-hidden className="absolute top-7 bottom-0 left-3.5 w-px bg-border" />

      <span
        aria-hidden
        className="absolute top-0 left-0 flex size-7 items-center justify-center rounded-full bg-subtle text-[10px] font-semibold text-muted"
      >
        {entry.severity === 'SECURITY' ? (
          <ShieldAlert className="size-3.5 text-danger" />
        ) : (
          initials(entry.actor.email ?? '?')
        )}
      </span>

      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} aria-hidden />
        <p className="text-sm text-text">{entry.summary}</p>
        <time
          dateTime={entry.createdAt}
          title={formatDateTime(entry.createdAt)}
          className="text-xs text-muted"
        >
          {formatRelative(entry.createdAt)}
        </time>
      </div>

      <p className="mt-0.5 text-xs text-muted">
        {entry.actor.email ?? 'System'}
        {entry.actor.role && ` · ${humanize(entry.actor.role)}`}
        {` · ${humanize(entry.action)}`}
      </p>

      {diff.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {open ? 'Hide changes' : `${diff.length} change${diff.length > 1 ? 's' : ''}`}
          </button>

          {open && (
            <table className="mt-2 w-full border-collapse rounded-md border border-border text-xs">
              <thead className="bg-subtle text-muted">
                <tr>
                  <th scope="col" className="px-2 py-1 text-left font-medium">
                    Field
                  </th>
                  <th scope="col" className="px-2 py-1 text-left font-medium">
                    Before
                  </th>
                  <th scope="col" className="px-2 py-1 text-left font-medium">
                    After
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {diff.map((row) => (
                  <tr key={row.field}>
                    <td className="px-2 py-1 font-medium text-text">{humanize(row.field)}</td>
                    <td className="px-2 py-1 font-mono text-muted line-through">
                      {render(row.before)}
                    </td>
                    <td className="px-2 py-1 font-mono text-text">{render(row.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </li>
  );
}

export function Timeline({
  entries,
  isLoading = false,
  emptyMessage = 'Nothing has happened here yet.',
  className,
}: {
  entries: ActivityDto[] | undefined;
  isLoading?: boolean;
  emptyMessage?: string;
  className?: string;
}) {
  if (isLoading) {
    return (
      <div className={cn('space-y-4', className)}>
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex gap-3">
            <Skeleton className="size-7 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return <EmptyState title="No activity" message={emptyMessage} className={className} />;
  }

  return (
    <ol className={cn('relative', className)}>
      {entries.map((entry) => (
        <TimelineEntry key={entry.id} entry={entry} />
      ))}
    </ol>
  );
}
