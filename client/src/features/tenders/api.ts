import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BidSummary,
  CreateTenderInput,
  Paginated,
  QuotationBuyerDto,
  SuggestedVendor,
  TenderBuyerDto,
  TenderVendorDto,
  UpdateTenderInput,
} from '@tb/shared';
import { apiDelete, apiGet, apiGetPage, apiPatch, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Tenders (plan 07).
 *
 * Buyer and vendor read different DTOs from different URLs — the vendor's omits
 * the internal estimated price, which is the whole point of having two (07 §6).
 * Nothing here can mix them up, because the hooks are separate.
 */

export const useTenders = (params: Record<string, string | number>) =>
  useQuery<Paginated<TenderBuyerDto>>({
    queryKey: qk.tenders.list(params),
    queryFn: () => apiGetPage<TenderBuyerDto>('/tenders', { params }),
  });

export const useTender = (id: string | undefined) =>
  useQuery({
    queryKey: qk.tenders.detail(id ?? ''),
    queryFn: () => apiGet<TenderBuyerDto>(`/tenders/${id}`),
    enabled: !!id,
  });

export const useVendorTenders = (params: Record<string, string | number>) =>
  useQuery<Paginated<TenderVendorDto>>({
    queryKey: qk.tenders.list({ scope: 'vendor', ...params }),
    queryFn: () => apiGetPage<TenderVendorDto>('/vendor/tenders', { params }),
  });

export const useVendorTender = (id: string | undefined) =>
  useQuery({
    queryKey: qk.tenders.detail(`vendor-${id}`),
    queryFn: () => apiGet<TenderVendorDto>(`/vendor/tenders/${id}`),
    enabled: !!id,
  });

/* --------------------------------- writes --------------------------------- */

const useTenderInvalidation = () => {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: qk.tenders.all });
    queryClient.invalidateQueries({ queryKey: qk.dashboard('ORG_ADMIN') });
    queryClient.invalidateQueries({ queryKey: qk.dashboard('ORG_OFFICER') });
  };
};

export const useCreateTender = () => {
  const invalidate = useTenderInvalidation();
  return useMutation({
    mutationFn: (input: CreateTenderInput) => apiPost<TenderBuyerDto>('/tenders', input),
    onSuccess: invalidate,
  });
};

export const useUpdateTender = (id: string | undefined) => {
  const invalidate = useTenderInvalidation();
  return useMutation({
    mutationFn: (input: UpdateTenderInput) => apiPatch<TenderBuyerDto>(`/tenders/${id}`, input),
    onSuccess: invalidate,
  });
};

/** The one hard delete in the system — a draft has no counterparties. */
export const useDeleteTender = () => {
  const invalidate = useTenderInvalidation();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/tenders/${id}`),
    onSuccess: invalidate,
  });
};

export const usePublishTender = () => {
  const invalidate = useTenderInvalidation();
  return useMutation({
    mutationFn: (id: string) => apiPost<TenderBuyerDto>(`/tenders/${id}/publish`),
    onSuccess: invalidate,
  });
};

export const useCancelTender = () => {
  const invalidate = useTenderInvalidation();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiPost<TenderBuyerDto>(`/tenders/${id}/cancel`, { reason }),
    onSettled: invalidate,
  });
};

/** Closes bidding early; the deadline job does the same thing on time. */
export const useCloseBidding = () => {
  const invalidate = useTenderInvalidation();
  return useMutation({
    mutationFn: (id: string) => apiPost<TenderBuyerDto>(`/tenders/${id}/close-bidding`),
    onSettled: invalidate,
  });
};

/* ------------------------------- invitations ------------------------------ */

export const useSuggestedVendors = (id: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...qk.tenders.detail(id ?? ''), 'suggested'] as const,
    queryFn: () => apiGet<SuggestedVendor[]>(`/tenders/${id}/suggested-vendors`),
    enabled: !!id && enabled,
  });

/**
 * `GET /tenders/:id/invitations` returns the invitation rows with their vendor
 * joined on. There is no DTO for it in `@tb/shared`, so the shape is declared
 * here — the one place in the client that models a response rather than
 * importing it.
 */
export interface TenderInvitationRow {
  id: string;
  tenderId: string;
  vendorId: string;
  invitedAt: string;
  viewedAt: string | null;
  respondedAt: string | null;
  declinedReason: string | null;
  vendor: { id: string; companyName: string; status: string; rating: string | null };
}

export const useTenderInvitations = (id: string | undefined) =>
  useQuery({
    queryKey: qk.tenders.invitations(id ?? ''),
    queryFn: () => apiGet<TenderInvitationRow[]>(`/tenders/${id}/invitations`),
    enabled: !!id,
  });

export const useInviteVendors = (id: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vendorIds: string[]) => apiPost(`/tenders/${id}/invitations`, { vendorIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.tenders.detail(id ?? '') });
      queryClient.invalidateQueries({ queryKey: qk.tenders.invitations(id ?? '') });
    },
  });
};

export const useUninviteVendor = (id: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vendorId: string) => apiDelete(`/tenders/${id}/invitations/${vendorId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.tenders.detail(id ?? '') });
      queryClient.invalidateQueries({ queryKey: qk.tenders.invitations(id ?? '') });
    },
  });
};

/** A vendor saying "not this time" — the officer sees it on the invitations tab. */
export const useDeclineTender = (id: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => apiPost(`/vendor/tenders/${id}/decline`, { reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.tenders.all }),
  });
};

/* ----------------------------------- bids --------------------------------- */

/**
 * Names, times and counts while the bids are sealed. **Never amounts** — the
 * server will not send them before `bidOpenedAt`, and this is the screen that
 * explains sealed bidding better than any paragraph (plan 17 §4).
 */
export const useBidSummary = (id: string | undefined, refetch = false) =>
  useQuery({
    queryKey: [...qk.tenders.detail(id ?? ''), 'bid-summary'] as const,
    queryFn: () => apiGet<BidSummary>(`/tenders/${id}/bid-summary`),
    enabled: !!id,
    // While a deadline is counting down, the submitted count is the live number
    // the officer is watching.
    refetchInterval: refetch ? 30_000 : false,
  });

export const useTenderQuotations = (id: string | undefined, enabled = true) =>
  useQuery({
    queryKey: qk.tenders.quotations(id ?? ''),
    queryFn: () => apiGet<QuotationBuyerDto[]>(`/tenders/${id}/quotations`),
    enabled: !!id && enabled,
  });
