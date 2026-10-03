import { NavLink } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/hooks/useAuth';
import { navFor } from '@/components/layout/nav';

/**
 * Permission-filtered navigation (plan 16 §7). The item list comes from
 * `nav.ts`, which is the one place that knows what each role's app looks like.
 */
export function Sidebar({
  collapsed,
  onToggle,
  onNavigate,
  className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Closes the drawer after a tap on mobile. */
  onNavigate?: () => void;
  className?: string;
}) {
  const { role, can } = useAuth();
  const sections = navFor(role, can);

  return (
    <nav
      aria-label="Main"
      className={cn(
        'flex h-full flex-col border-r border-border bg-surface transition-[width]',
        collapsed ? 'w-14' : 'w-56',
        className,
      )}
    >
      <div className="flex-1 overflow-y-auto py-2">
        {sections.map((section, index) => (
          <div key={section.label ?? index} className="mb-1">
            {section.label && !collapsed && (
              <p className="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">
                {section.label}
              </p>
            )}
            {section.label && collapsed && index > 0 && <div className="mx-3 my-2 h-px bg-border" />}

            <ul>
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    onClick={onNavigate}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'mx-1.5 my-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                        collapsed && 'justify-center px-0',
                        isActive
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-muted hover:bg-subtle hover:text-text',
                      )
                    }
                  >
                    <item.icon aria-hidden className="size-4 shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="flex items-center gap-2.5 border-t border-border px-3 py-2.5 text-xs text-muted hover:bg-subtle hover:text-text"
      >
        {collapsed ? (
          <PanelLeftOpen aria-hidden className="size-4" />
        ) : (
          <>
            <PanelLeftClose aria-hidden className="size-4" />
            Collapse
          </>
        )}
      </button>
    </nav>
  );
}
