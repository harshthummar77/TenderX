import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Sidebar } from '@/components/layout/Sidebar';
import { Topbar } from '@/components/layout/Topbar';

const COLLAPSED_KEY = 'tb.sidebar.collapsed';

/**
 * The frame every authenticated screen renders inside (plan 16 §7).
 *
 * The sidebar's collapsed state is the one thing kept in `localStorage` — a UI
 * preference, not session data. Nothing about the session is ever persisted (§3).
 */
export function AppShell() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === 'true',
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  // A navigation must close the mobile drawer, or the new page opens behind it.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  return (
    <div className="flex h-screen flex-col bg-bg">
      <Topbar onOpenSidebar={() => setDrawerOpen(true)} />

      <div className="flex min-h-0 flex-1">
        <div className="hidden lg:block">
          <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
        </div>

        {/* Mobile: the same sidebar as a drawer, rather than a second component. */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 flex lg:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setDrawerOpen(false)}
              aria-hidden
            />
            <div className="relative">
              <Sidebar
                collapsed={false}
                onToggle={() => setDrawerOpen(false)}
                onNavigate={() => setDrawerOpen(false)}
                className="h-full shadow-xl"
              />
            </div>
          </div>
        )}

        {/* The only scroll container: the topbar and sidebar stay put, and a
            sticky table header inside a page keeps working. */}
        <main className={cn('min-w-0 flex-1 overflow-y-auto')}>
          <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
