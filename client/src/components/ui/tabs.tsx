import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

const useTabs = (): TabsContextValue => {
  const context = useContext(TabsContext);
  if (!context) throw new Error('<Tab*> must be used inside <Tabs>');
  return context;
};

/**
 * Tabs for a detail screen (Overview / Items / Documents / History).
 *
 * Uncontrolled by default; pass `value` + `onValueChange` to drive the active tab
 * from the URL, which is what the detail screens do so a tab is linkable.
 */
export function Tabs({
  defaultValue,
  value: controlled,
  onValueChange,
  children,
  className,
}: {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const baseId = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? '');
  const value = controlled ?? uncontrolled;

  const setValue = (next: string) => {
    if (controlled === undefined) setUncontrolled(next);
    onValueChange?.(next);
  };

  return (
    <TabsContext.Provider value={{ value, setValue, baseId }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="tablist"
      className={cn('flex items-center gap-1 overflow-x-auto border-b border-border', className)}
    >
      {children}
    </div>
  );
}

export function Tab({
  value,
  children,
  count,
  className,
}: {
  value: string;
  children: ReactNode;
  /** A pending-count beside the label — "Exceptions 3" is worth a glance. */
  count?: number;
  className?: string;
}) {
  const tabs = useTabs();
  const selected = tabs.value === value;

  return (
    <button
      type="button"
      role="tab"
      id={`${tabs.baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${tabs.baseId}-panel-${value}`}
      onClick={() => tabs.setValue(value)}
      className={cn(
        '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
        selected
          ? 'border-primary text-primary'
          : 'border-transparent text-muted hover:border-border-strong hover:text-text',
        className,
      )}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className="ml-1.5 rounded-full bg-subtle px-1.5 py-0.5 text-[11px] text-muted">
          {count}
        </span>
      )}
    </button>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const tabs = useTabs();
  if (tabs.value !== value) return null;

  return (
    <div
      role="tabpanel"
      id={`${tabs.baseId}-panel-${value}`}
      aria-labelledby={`${tabs.baseId}-tab-${value}`}
      className={cn('pt-4', className)}
    >
      {children}
    </div>
  );
}
