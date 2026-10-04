import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDeliveryInput, DeliveryDto, Paginated } from '@tb/shared';
import { apiGet, apiGetPage, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Deliveries (plan 11). The vendor dispatches; the buyer only reads, because a
 * delivery is the vendor's assertion about what left their warehouse. What the
 * buyer asserts is the goods receipt.
 */

export const useMyDeliveries = (params: Record<string, string | number>, enabled = true) =>
  useQuery<Paginated<DeliveryDto>>({
    queryKey: qk.deliveries.list({ scope: 'vendor', ...params }),
    queryFn: () => apiGetPage<DeliveryDto>('/vendor/deliveries', { params }),
    enabled,
  });

export const useDelivery = (id: string | undefined, scope: 'buyer' | 'vendor' = 'vendor') =>
  useQuery({
    queryKey: qk.deliveries.detail(id ?? ''),
    queryFn: () =>
      apiGet<DeliveryDto>(scope === 'vendor' ? `/vendor/deliveries/${id}` : `/deliveries/${id}`),
    enabled: !!id,
  });

export const useCreateDelivery = (poId: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDeliveryInput) =>
      apiPost<DeliveryDto>(`/vendor/purchase-orders/${poId}/deliveries`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.deliveries.all });
      queryClient.invalidateQueries({ queryKey: qk.purchaseOrders.all });
    },
  });
};

export const useCancelDelivery = (id: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      apiPost<DeliveryDto>(`/vendor/deliveries/${id}/cancel`, { reason }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.deliveries.all });
      queryClient.invalidateQueries({ queryKey: qk.purchaseOrders.all });
    },
  });
};
