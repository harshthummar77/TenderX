import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FulfilmentDto,
  Paginated,
  PurchaseOrderDto,
} from '@tb/shared';
import { apiDownload, apiGet, apiGetPage, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Purchase orders (plan 10).
 *
 * Buyer and vendor read different URLs for the same document — `/purchase-orders`
 * and `/vendor/purchase-orders` — so the hooks take a `scope` rather than
 * letting every screen remember which prefix it is on.
 */

export type PoScope = 'buyer' | 'vendor';

const base = (scope: PoScope) => (scope === 'vendor' ? '/vendor/purchase-orders' : '/purchase-orders');

export const usePurchaseOrders = (scope: PoScope, params: Record<string, string | number>) =>
  useQuery<Paginated<PurchaseOrderDto>>({
    queryKey: qk.purchaseOrders.list({ scope, ...params }),
    queryFn: () => apiGetPage<PurchaseOrderDto>(base(scope), { params }),
  });

export const usePurchaseOrder = (scope: PoScope, id: string | undefined) =>
  useQuery({
    queryKey: qk.purchaseOrders.detail(id ?? ''),
    queryFn: () => apiGet<PurchaseOrderDto>(`${base(scope)}/${id}`),
    enabled: !!id,
  });

/** Line-by-line ordered / received / accepted / invoiced. Buyer only. */
export const useFulfilment = (id: string | undefined) =>
  useQuery({
    queryKey: qk.purchaseOrders.fulfilment(id ?? ''),
    queryFn: () => apiGet<FulfilmentDto>(`/purchase-orders/${id}/fulfilment`),
    enabled: !!id,
  });

/**
 * Every PO mutation invalidates the whole module plus the dashboard: issuing an
 * order changes a tile, and accepting one changes two. Optimistic locking is not
 * implemented (00 §3), so a failed mutation refetches rather than guessing
 * (plan 17 §8).
 */
const usePoMutation = <TInput>(path: (id: string) => string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: TInput }) =>
      apiPost<PurchaseOrderDto>(path(id), input),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.purchaseOrders.all });
      queryClient.invalidateQueries({ queryKey: qk.dashboard('ORG_ADMIN') });
      queryClient.invalidateQueries({ queryKey: qk.dashboard('VENDOR') });
    },
  });
};

export const useIssuePo = () => usePoMutation<void>((id) => `/purchase-orders/${id}/issue`);

export const useCancelPo = () =>
  usePoMutation<{ reason: string }>((id) => `/purchase-orders/${id}/cancel`);

export const useAcceptPo = () =>
  usePoMutation<{ note?: string }>((id) => `/vendor/purchase-orders/${id}/accept`);

export const useRejectPo = () =>
  usePoMutation<{ reason: string }>((id) => `/vendor/purchase-orders/${id}/reject`);

/** Short-close writes off the undelivered balance; it lives with the GRN module. */
export const useShortClose = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiPost(`/purchase-orders/${id}/short-close`, { reason }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.purchaseOrders.all });
      queryClient.invalidateQueries({ queryKey: qk.grns.all });
    },
  });
};

/**
 * The PDF endpoint streams the rendered document (plan 10 §8) rather than
 * redirecting, so unlike a stored document it can be fetched with the bearer
 * token and handed to the browser as a blob.
 */
export async function downloadPoPdf(id: string, poNumber: string): Promise<void> {
  const blob = await apiDownload(`/purchase-orders/${id}/pdf`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${poNumber.replace(/\//g, '-')}.pdf`;
  anchor.click();
  URL.revokeObjectURL(url);
}
