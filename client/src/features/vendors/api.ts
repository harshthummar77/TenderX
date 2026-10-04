import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CategoryDto,
  CreateVendorInput,
  Paginated,
  UpdateVendorInput,
  VendorAdminDto,
  VendorPublicDto,
  VendorScorecard,
  VendorSelfDto,
} from '@tb/shared';
import { apiGet, apiGetPage, apiPatch, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Vendors (plan 06). Three audiences, three DTOs, and the hooks keep them
 * straight: a buyer reads `VendorPublicDto` (never bank details), the vendor
 * reads `VendorSelfDto`, the platform reviewer reads `VendorAdminDto`.
 */

export const useVendors = (params: Record<string, string | number>) =>
  useQuery<Paginated<VendorPublicDto>>({
    queryKey: qk.vendors.list(params),
    queryFn: () => apiGetPage<VendorPublicDto>('/vendors', { params }),
  });

export const useVendor = (id: string | undefined) =>
  useQuery({
    queryKey: qk.vendors.detail(id ?? ''),
    queryFn: () => apiGet<VendorPublicDto>(`/vendors/${id}`),
    enabled: !!id,
  });

export const useVendorScorecard = (id: string | undefined) =>
  useQuery({
    queryKey: qk.vendors.scorecard(id ?? ''),
    queryFn: () => apiGet<VendorScorecard>(`/vendors/${id}/scorecard`),
    enabled: !!id,
  });

export const useCreateVendor = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVendorInput) => apiPost<VendorPublicDto>('/vendors', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.vendors.all }),
  });
};

export const useCategories = () =>
  useQuery({
    queryKey: qk.categories.list(),
    queryFn: () => apiGet<CategoryDto[]>('/categories'),
    // Categories change about twice a year; re-fetching them per screen is waste.
    staleTime: 10 * 60_000,
  });

/* --------------------------------- vendor's own record -------------------- */

export const useMyVendor = () =>
  useQuery({
    queryKey: qk.vendors.me,
    queryFn: () => apiGet<VendorSelfDto>('/vendors/me'),
  });

export const useMyScorecard = () =>
  useQuery({
    queryKey: [...qk.vendors.me, 'scorecard'],
    queryFn: () => apiGet<VendorScorecard>('/vendors/me/scorecard'),
  });

export const useUpdateMyVendor = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateVendorInput) => apiPatch<VendorSelfDto>('/vendors/me', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.vendors.all }),
  });
};

export const useUpdateMyCategories = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (categoryIds: string[]) =>
      apiPatch<VendorSelfDto>('/vendors/me/categories', { categoryIds }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.vendors.all }),
  });
};

/* --------------------------------- platform review ------------------------ */

export const usePlatformVendors = (params: Record<string, string | number>) =>
  useQuery<Paginated<VendorPublicDto>>({
    queryKey: qk.vendors.list({ scope: 'platform', ...params }),
    queryFn: () => apiGetPage<VendorPublicDto>('/platform/vendors', { params }),
  });

export const usePlatformVendor = (id: string | undefined) =>
  useQuery({
    queryKey: qk.vendors.detail(`platform-${id}`),
    queryFn: () => apiGet<VendorAdminDto>(`/platform/vendors/${id}`),
    enabled: !!id,
  });

/**
 * The five review decisions. One hook, because they differ only in URL and
 * whether they carry a reason — and because every one of them must invalidate
 * the same three caches.
 */
export const useVendorDecision = (id: string | undefined) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      action,
      reason,
    }: {
      action: 'approve' | 'reject' | 'suspend' | 'reinstate' | 'blacklist';
      reason?: string;
    }) =>
      apiPost<VendorAdminDto>(
        `/platform/vendors/${id}/${action}`,
        reason === undefined ? undefined : { reason },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.vendors.all });
      queryClient.invalidateQueries({ queryKey: qk.dashboard('PLATFORM_ADMIN') });
    },
  });
};
