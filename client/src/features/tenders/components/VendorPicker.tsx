import { useState } from 'react';
import { Check, Search, Sparkles, Star } from 'lucide-react';
import type { SuggestedVendor } from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useDebounce } from '@/hooks/useDebounce';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useVendors } from '@/features/vendors/api';

/**
 * Vendor selection for a tender (plan 17 §3, step 4).
 *
 * Two lists, deliberately: the suggestions come with **reasons** ("supplies this
 * category", "4.2 rating over 7 orders"), which is what makes them trustworthy
 * rather than magic, and the search is there because the officer often already
 * knows who they want.
 *
 * The "3 of 3 minimum vendors selected" line is the whole point of the screen:
 * the server refuses to publish below the organization's minimum, so the count
 * is shown before the publish button is pressed, not after.
 */
export function VendorPicker({
  selected,
  onChange,
  suggestions,
  isLoadingSuggestions,
  minimum,
}: {
  selected: string[];
  onChange: (vendorIds: string[]) => void;
  suggestions: SuggestedVendor[] | undefined;
  isLoadingSuggestions: boolean;
  minimum: number;
}) {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 300);
  const directory = useVendors({
    limit: 10,
    status: 'APPROVED',
    ...(debounced ? { q: debounced } : {}),
  });

  const toggle = (vendorId: string) =>
    onChange(
      selected.includes(vendorId)
        ? selected.filter((id) => id !== vendorId)
        : [...selected, vendorId],
    );

  const enough = selected.length >= minimum;

  return (
    <div className="space-y-5">
      <div
        className={cn(
          'flex items-center justify-between rounded-md border px-3 py-2 text-sm',
          enough ? 'border-success/30 bg-success/10' : 'border-warning/30 bg-warning/10',
        )}
      >
        <span className="font-medium">
          {selected.length} of {minimum} minimum vendors selected
        </span>
        <span>{enough ? '✓' : `select ${minimum - selected.length} more to publish`}</span>
      </div>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
          <Sparkles aria-hidden className="size-3.5" />
          Suggested
        </h3>

        {isLoadingSuggestions ? (
          <Skeleton className="h-32 w-full" />
        ) : !suggestions || suggestions.length === 0 ? (
          <p className="text-xs text-muted">
            No suggestions yet — pick a category on step 1, or search the directory below.
          </p>
        ) : (
          <ul className="space-y-2">
            {suggestions.map((vendor) => {
              const picked = selected.includes(vendor.vendorId);
              return (
                <li key={vendor.vendorId}>
                  <button
                    type="button"
                    onClick={() => toggle(vendor.vendorId)}
                    aria-pressed={picked}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors',
                      picked
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-surface hover:bg-subtle',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
                        picked ? 'border-primary bg-primary text-on-primary' : 'border-border',
                      )}
                    >
                      {picked && <Check aria-hidden className="size-3" />}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{vendor.companyName}</span>
                        {vendor.isNew && <Badge tone="info">new vendor</Badge>}
                        {vendor.rating !== null && (
                          <span className="inline-flex items-center gap-0.5 font-mono text-xs tabular-nums text-muted">
                            <Star aria-hidden className="size-3 fill-warning text-warning" />
                            {vendor.rating.toFixed(1)}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {vendor.reasons.join(' · ')}
                      </span>
                    </span>

                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                      {Math.round(vendor.score)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
          Search the directory
        </h3>

        <div className="relative mb-2">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search approved vendors by name, GSTIN or city…"
            className="pl-8"
          />
        </div>

        {directory.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (directory.data?.data ?? []).length === 0 ? (
          <p className="text-xs text-muted">No approved vendors match that search.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {(directory.data?.data ?? []).map((vendor) => {
              const picked = selected.includes(vendor.id);
              return (
                <li key={vendor.id}>
                  <button
                    type="button"
                    onClick={() => toggle(vendor.id)}
                    aria-pressed={picked}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-subtle"
                  >
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded border',
                        picked ? 'border-primary bg-primary text-on-primary' : 'border-border',
                      )}
                    >
                      {picked && <Check aria-hidden className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{vendor.companyName}</span>
                      <span className="block truncate text-xs text-muted">
                        {vendor.city}, {vendor.state} · {formatCount(vendor.totalOrders)} orders
                      </span>
                    </span>
                    {vendor.rating !== null && (
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                        {vendor.rating.toFixed(1)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
