import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgeingDto,
  CreateInvoiceInput,
  InvoiceDto,
  InvoiceableDto,
  Paginated,
  UpdateInvoiceInput,
} from '@tb/shared';
import { apiDownload, apiGet, apiGetPage, apiPatch, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Invoices and the three-way match (plan 12).
 *
 * Both sides read an `InvoiceDto`; only the buyer's copy carries a `matchResult`
 * worth acting on, and only the buyer can approve, reject or override.
 */

export type InvoiceScope = 'buyer' | 'vendor';

const base = (scope: InvoiceScope) => (scope === 'vendor' ? '/vendor/invoices' : '/invoices');

export const useInvoices = (
  scope: InvoiceScope,
  params: Record<string, string | number>,
  enabled = true,
) =>
  useQuery<Paginated<InvoiceDto>>({
    queryKey: qk.invoices.list({ scope, ...params }),
    queryFn: () => apiGetPage<InvoiceDto>(base(scope), { params }),
    enabled,
  });

export const useInvoice = (scope: InvoiceScope, id: string | undefined) =>
  useQuery({
    queryKey: qk.invoices.detail(id ?? ''),
    queryFn: () => apiGet<InvoiceDto>(`${base(scope)}/${id}`),
    enabled: !!id,
  });

export const useAgeing = (params?: Record<string, string | number>) =>
  useQuery({
    queryKey: qk.invoices.ageing(params),
    queryFn: () => apiGet<AgeingDto>('/invoices/ageing', { params }),
  });

/* ------------------------------- vendor side ------------------------------ */

/** What is left to bill on an order: accepted minus already invoiced. */
export const useInvoiceable = (poId: string | undefined) =>
  useQuery({
    queryKey: [...qk.purchaseOrders.detail(poId ?? ''), 'invoiceable'] as const,
    queryFn: () => apiGet<InvoiceableDto>(`/vendor/purchase-orders/${poId}/invoiceable`),
    enabled: !!poId,
    staleTime: 0,
  });

const useInvoiceInvalidation = () => {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: qk.invoices.all });
    queryClient.invalidateQueries({ queryKey: qk.purchaseOrders.all });
    queryClient.invalidateQueries({ queryKey: qk.payments.all });
    queryClient.invalidateQueries({ queryKey: qk.approvals.all });
  };
};

export const useCreateInvoice = (poId: string | undefined) => {
  const invalidate = useInvoiceInvalidation();
  return useMutation({
    mutationFn: (input: CreateInvoiceInput) =>
      apiPost<InvoiceDto>(`/vendor/purchase-orders/${poId}/invoices`, input),
    onSuccess: invalidate,
  });
};

export const useUpdateInvoice = (id: string | undefined) => {
  const invalidate = useInvoiceInvalidation();
  return useMutation({
    mutationFn: (input: UpdateInvoiceInput) =>
      apiPatch<InvoiceDto>(`/vendor/invoices/${id}`, input),
    onSuccess: invalidate,
  });
};

export const useSubmitInvoice = (id: string | undefined) => {
  const invalidate = useInvoiceInvalidation();
  return useMutation({
    mutationFn: () => apiPost<InvoiceDto>(`/vendor/invoices/${id}/submit`, {}),
    onSuccess: invalidate,
  });
};

/* -------------------------------- buyer side ------------------------------ */

/** Re-runs the three-way match — used after a GRN lands late. */
export const useRematch = (id: string | undefined) => {
  const invalidate = useInvoiceInvalidation();
  return useMutation({
    mutationFn: () => apiPost<InvoiceDto>(`/invoices/${id}/rematch`, {}),
    onSuccess: invalidate,
  });
};

export const useApproveInvoice = (id: string | undefined) => {
  const invalidate = useInvoiceInvalidation();
  return useMutation({
    mutationFn: (comment?: string) =>
      apiPost<InvoiceDto>(`/invoices/${id}/approve`, comment ? { comment } : {}),
    onSettled: invalidate,
  });
};

export const useRejectInvoice = (id: string | undefined) => {
  const invalidate = useInvoiceInvalidation();
  return useMutation({
    mutationFn: (reason: string) => apiPost<InvoiceDto>(`/invoices/${id}/reject`, { reason }),
    onSettled: invalidate,
  });
};

/**
 * Admin only, written reason, SECURITY audit row — and the server refuses it
 * outright for a quantity exception, because goods that were not received cannot
 * be invoiced (plan 12 §7).
 */
export const useOverrideMatch = (id: string | undefined) => {
  const invalidate = useInvoiceInvalidation();
  return useMutation({
    mutationFn: (reason: string) =>
      apiPost<InvoiceDto>(`/invoices/${id}/override-match`, { reason }),
    onSettled: invalidate,
  });
};

export async function downloadInvoicePdf(id: string, reference: string): Promise<void> {
  const blob = await apiDownload(`/invoices/${id}/pdf`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${reference.replace(/\//g, '-')}.pdf`;
  anchor.click();
  URL.revokeObjectURL(url);
}
