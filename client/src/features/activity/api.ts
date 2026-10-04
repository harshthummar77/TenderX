import { useQuery } from '@tanstack/react-query';
import type { ActivityDto, ChainVerificationDto, Paginated } from '@tb/shared';
import { apiGet, apiGetPage } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Activity (plan 14 §C) — the audit trail behind every "History" tab.
 */

/** The timeline on a detail screen: one entity's trail, newest first. */
export const useEntityActivity = (entityType: string, entityId: string | undefined, limit = 50) =>
  useQuery<Paginated<ActivityDto>>({
    queryKey: qk.activity.forEntity(entityType, entityId ?? ''),
    queryFn: () =>
      apiGetPage<ActivityDto>('/activity', { params: { entityType, entityId, limit } }),
    enabled: !!entityId,
  });

export const useActivity = (params: Record<string, string | number>) =>
  useQuery<Paginated<ActivityDto>>({
    queryKey: qk.activity.list(params),
    queryFn: () => apiGetPage<ActivityDto>('/activity', { params }),
  });

/** The platform admin's cross-tenant feed. */
export const usePlatformActivity = (params: Record<string, string | number>) =>
  useQuery<Paginated<ActivityDto>>({
    queryKey: qk.activity.list({ scope: 'platform', ...params }),
    queryFn: () => apiGetPage<ActivityDto>('/platform/activity', { params }),
  });

/**
 * Recomputes every hash in the chain and names the first row that does not
 * reproduce. Safe to run live on stage — it is a read.
 */
export const useVerifyChain = (enabled: boolean) =>
  useQuery<ChainVerificationDto>({
    queryKey: qk.activity.verify,
    queryFn: () => apiGet<ChainVerificationDto>('/platform/activity/verify'),
    enabled,
    staleTime: 0,
  });
