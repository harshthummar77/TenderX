import { QueryClient } from '@tanstack/react-query';
import { isApiError } from '@/lib/api';

/**
 * Query defaults (plan 16 §6).
 *
 * `refetchOnWindowFocus` is doing real work here: it is the replacement for the
 * SSE live updates that were cut (00 §3). Switch to another browser profile to
 * approve something, come back, and the list is already right.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // One retry, but never on a 4xx: a 403 or a 422 is a verdict, not a blip,
      // and retrying it only doubles the latency before the error renders.
      retry: (failureCount, error) => {
        if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
        return failureCount < 1;
      },
      retryDelay: 400,
    },
    mutations: {
      // Nothing in this app is safe to replay blindly — a retried
      // "record payment" is a second payment.
      retry: false,
    },
  },
});

/** On logout: the next user on this machine must not see the last one's cache. */
export const clearQueryCache = () => {
  queryClient.cancelQueries();
  queryClient.clear();
};
