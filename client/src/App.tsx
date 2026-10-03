import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { bootstrapSession } from '@/lib/session';
import { router } from '@/router';
import { selectStatus, useAuthStore } from '@/stores/authStore';
import { FullPageSpinner } from '@/components/ui/spinner';
import { Toaster } from '@/components/ui/toast';

/**
 * The boot gate (plan 16 §3).
 *
 * The routes are not rendered until the one `POST /auth/refresh` has settled. That
 * ordering is the whole trick behind "hard-refresh and you are still signed in,
 * with no flash of the login screen": the access token lives only in memory, so
 * immediately after a reload the app does not yet know who the user is — and a
 * router rendered in that moment would send them to /login before the answer
 * arrived.
 */
export function App() {
  const status = useAuthStore(selectStatus);

  useEffect(() => {
    void bootstrapSession();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {status === 'loading' ? <FullPageSpinner /> : <RouterProvider router={router} />}
      {/* Outside the router, so a toast survives a navigation. */}
      <Toaster />
    </QueryClientProvider>
  );
}
