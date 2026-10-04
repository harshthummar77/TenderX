import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Paginated,
  QuotationBuyerDto,
  QuotationDraftInput,
  QuotationVendorDto,
  SealVerification,
} from '@tb/shared';
import { apiGet, apiGetPage, apiPatch, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Quotations (plan 08).
 *
 * The vendor's own bid is always fully visible to them; the buyer's view of the
 * same bid is sealed until the deadline, which is why the two sides read
 * different URLs and different DTOs.
 */

export const useMyQuotations = (params: Record<string, string | number>) =>
  useQuery<Paginated<QuotationVendorDto>>({
    queryKey: qk.quotations.list({ scope: 'mine', ...params }),
    queryFn: () => apiGetPage<QuotationVendorDto>('/vendor/quotations', { params }),
  });

export const useMyQuotation = (id: string | undefined) =>
  useQuery({
    queryKey: qk.quotations.detail(id ?? ''),
    queryFn: () => apiGet<QuotationVendorDto>(`/vendor/quotations/${id}`),
    enabled: !!id,
  });

/** The buyer's view of one bid — sealed or opened, decided by the server. */
export const useQuotationForBuyer = (id: string | undefined) =>
  useQuery({
    queryKey: qk.quotations.detail(`buyer-${id}`),
    queryFn: () => apiGet<QuotationBuyerDto>(`/quotations/${id}`),
    enabled: !!id,
  });

/**
 * Opens (or re-opens) the draft for a tender. Idempotent on the server, so the
 * "Submit quotation" button can simply call it and navigate to what comes back.
 */
export const useOpenDraft = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tenderId: string) =>
      apiPost<QuotationVendorDto>(`/vendor/tenders/${tenderId}/quotation`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.quotations.all }),
  });
};

/**
 * The autosave target. Every total the client sends is ignored and recomputed
 * server-side (plan 08 §4) — the figures in the request body exist only because
 * it is simpler for the builder to PATCH its whole state back than to strip its
 * own display fields.
 */
export const useSaveDraft = (id: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: QuotationDraftInput) =>
      apiPatch<QuotationVendorDto>(`/vendor/quotations/${id}`, input),
    onSuccess: (quotation) => {
      // The response carries the server's own totals; seeding the cache with it
      // keeps the header figures honest without a second request.
      queryClient.setQueryData(qk.quotations.detail(id ?? ''), quotation);
    },
  });
};

export const useSubmitQuotation = (id: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<QuotationVendorDto>(`/vendor/quotations/${id}/submit`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.quotations.all });
      queryClient.invalidateQueries({ queryKey: qk.tenders.all });
      queryClient.invalidateQueries({ queryKey: qk.dashboard('VENDOR') });
    },
  });
};

export const useWithdrawQuotation = (id: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      apiPost<QuotationVendorDto>(`/vendor/quotations/${id}/withdraw`, { reason }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.quotations.all });
      queryClient.invalidateQueries({ queryKey: qk.tenders.all });
    },
  });
};

/** Opens a new revision of a submitted bid, while the deadline still allows it. */
export const useReviseQuotation = (id: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<QuotationVendorDto>(`/vendor/quotations/${id}/revise`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.quotations.all }),
  });
};

/** Recomputes the seal from the stored rows — proof nothing changed after sealing. */
export const useVerifySeal = (id: string | undefined) =>
  useMutation({
    mutationFn: () => apiPost<SealVerification>(`/quotations/${id}/verify-seal`, {}),
  });
