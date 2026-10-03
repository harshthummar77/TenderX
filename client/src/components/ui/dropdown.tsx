import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';

/**
 * A click-to-open menu: the user dropdown in the topbar, the row "⋯" menu, the
 * column-visibility picker in `DataTable`.
 *
 * Closes on outside click, on Escape, and on choosing an item. Not hover-opened —
 * a hover menu on a dense table is a trap for the cursor.
 */
export function Dropdown({
  trigger,
  children,
  align = 'end',
  className,
  menuClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  className?: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {trigger({ open, toggle: () => setOpen((value) => !value), id })}
      {open && (
        <div
          role="menu"
          aria-labelledby={id}
          className={cn(
            'absolute z-40 mt-1 min-w-48 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-lg',
            align === 'end' ? 'right-0' : 'left-0',
            menuClassName,
          )}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

const ITEM_CLASS =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text transition-colors hover:bg-subtle disabled:pointer-events-none disabled:opacity-50';

export function DropdownItem({
  children,
  onClick,
  icon,
  danger = false,
  disabled = false,
}: {
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(ITEM_CLASS, danger && 'text-danger hover:bg-danger/10')}
    >
      {icon}
      {children}
    </button>
  );
}

export function DropdownLink({
  to,
  children,
  icon,
  onClick,
}: {
  to: string;
  children: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Link role="menuitem" to={to} onClick={onClick} className={ITEM_CLASS}>
      {icon}
      {children}
    </Link>
  );
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <p className="px-3 py-1.5 text-xs font-medium text-muted">{children}</p>;
}

export function DropdownSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}
