import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateGrnInput, GrnDto, Paginated, ReceivableDto } from '@tb/shared';
import { apiGet, apiGetPage, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Goods receipt (plan 11).
 *
 * The GRN is the buyer's assertion about what actually arrived and what was
 * accepted, and it is what the three-way match checks an invoice against — which
 * is why `acceptedQuantity` is the figure the whole finance side depends on.
 */

export const useGrns = (params: Record<string, string | number>, enabled = true) =>
  useQuery<Paginated<GrnDto>>({
    queryKey: qk.grns.list(params),
    queryFn: () => apiGetPage<GrnDto>('/grns', { params }),
    enabled,
  });

export const useGrn = (id: string | undefined) =>
  useQuery({
    queryKey: qk.grns.detail(id ?? ''),
    queryFn: () => apiGet<GrnDto>(`/grns/${id}`),
    enabled: !!id,
  });

/** The prefilled capture screen: an officer holding a challan should not retype it. */
export const useReceivable = (poId: string | undefined) =>
  useQuery({
    queryKey: qk.purchaseOrders.receivable(poId ?? ''),
    queryFn: () => apiGet<ReceivableDto>(`/purchase-orders/${poId}/receivable`),
    enabled: !!poId,
    // Two officers receiving against the same order would otherwise work from a
    // stale "already received" figure.
    staleTime: 0,
  });

export const useCreateGrn = (poId: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGrnInput) => apiPost<GrnDto>(`/purchase-orders/${poId}/grns`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.grns.all });
      queryClient.invalidateQueries({ queryKey: qk.purchaseOrders.all });
      queryClient.invalidateQueries({ queryKey: qk.deliveries.all });
    },
  });
};
