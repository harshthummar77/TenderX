import { useQuery } from '@tanstack/react-query';
import type { DashboardResponse } from '@tb/shared';
import { apiGet } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * The dashboard (plan 15). One endpoint, three payloads: the server decides
 * which dashboard the caller gets from their role, so the client asks once and
 * dispatches on `role` in the response.
 */
export const useDashboard = (role: string | null) =>
  useQuery({
    queryKey: qk.dashboard(role ?? 'unknown'),
    queryFn: () => apiGet<DashboardResponse>('/dashboard'),
    enabled: !!role,
    // A dashboard that is a minute stale is fine; one that re-fetches on every
    // focus is not, because these aggregates are the most expensive reads here.
    staleTime: 60_000,
  });
