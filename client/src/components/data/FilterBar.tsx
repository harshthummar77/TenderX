import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useDebounce } from '@/hooks/useDebounce';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * The filter row above every list screen.
 *
 * **Filters live in the query string** (plan 17 §8), so `/invoices?matchStatus=EXCEPTION`
 * is a real, shareable, refresh-proof URL — which is what makes the dashboard
 * tiles deep-link to a filtered list instead of a bare page.
 *
 * `/` focuses the search box, the way it does in every tool these users already
 * use. It is ignored while they are typing in another field.
 */
export function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder = 'Search…',
  children,
  actions,
  onClear,
  activeCount = 0,
  className,
}: {
  search?: string;
  onSearchChange?: (value: string | undefined) => void;
  searchPlaceholder?: string;
  /** Status selects, date pickers — whatever this list filters on. */
  children?: ReactNode;
  actions?: ReactNode;
  onClear?: () => void;
  activeCount?: number;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(search ?? '');
  const debounced = useDebounce(draft, 300);
  const lastPushed = useRef(search ?? '');

  // The URL is the source of truth; typing updates it, and a back button or a
  // dashboard deep link updates the box.
  useEffect(() => {
    if ((search ?? '') !== lastPushed.current) {
      setDraft(search ?? '');
      lastPushed.current = search ?? '';
    }
  }, [search]);

  useEffect(() => {
    if (!onSearchChange) return;
    if (debounced === lastPushed.current) return;
    lastPushed.current = debounced;
    onSearchChange(debounced || undefined);
  }, [debounced, onSearchChange]);

  useEffect(() => {
    if (!onSearchChange) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable;
      if (typing) return;

      event.preventDefault();
      inputRef.current?.focus();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onSearchChange]);

  return (
    <div className={cn('mb-3 flex flex-wrap items-center gap-2', className)}>
      {onSearchChange && (
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
          />
          <Input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search"
            className="pl-8"
          />
        </div>
      )}

      {children}

      {onClear && activeCount > 0 && (
        <Button variant="ghost" size="sm" onClick={onClear} leftIcon={<X className="size-3.5" />}>
          Clear {activeCount === 1 ? 'filter' : `${activeCount} filters`}
        </Button>
      )}

      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
