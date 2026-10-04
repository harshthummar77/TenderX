import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OrganizationDto,
  Paginated,
  PlatformOrgListItem,
  PlatformStats,
} from '@tb/shared';
import { apiGet, apiGetPage, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * The platform admin's cross-tenant reads (plan 05 §6).
 *
 * PLATFORM_ADMIN is read-only on tenant data by design — it approves
 * organizations and vendors and reads audit logs, and holds no create or payment
 * permission on anybody's tenant (04 §7). The hooks here mirror that: queries
 * for everything, mutations only for the three organization decisions.
 */

export const usePlatformOrganizations = (params: Record<string, string | number>) =>
  useQuery<Paginated<PlatformOrgListItem>>({
    queryKey: qk.organizations.list({ scope: 'platform', ...params }),
    queryFn: () => apiGetPage<PlatformOrgListItem>('/platform/organizations', { params }),
  });

export const usePlatformOrganization = (id: string | undefined) =>
  useQuery({
    queryKey: qk.organizations.detail(`platform-${id}`),
    queryFn: () => apiGet<OrganizationDto>(`/platform/organizations/${id}`),
    enabled: !!id,
  });

export const usePlatformStats = () =>
  useQuery({
    queryKey: ['platform', 'stats'] as const,
    queryFn: () => apiGet<PlatformStats>('/platform/stats'),
    // The system-health block is the point of this screen; keep it fresh.
    refetchInterval: 60_000,
  });

export const useOrganizationDecision = (id: string | undefined) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      action,
      reason,
    }: {
      action: 'approve' | 'reject' | 'suspend';
      reason?: string;
    }) =>
      apiPost<OrganizationDto>(
        `/platform/organizations/${id}/${action}`,
        reason === undefined ? undefined : { reason },
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.organizations.all });
      queryClient.invalidateQueries({ queryKey: ['platform'] });
      queryClient.invalidateQueries({ queryKey: qk.dashboard('PLATFORM_ADMIN') });
    },
  });
};
