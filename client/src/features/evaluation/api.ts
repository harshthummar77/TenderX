import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDetailDto, ApprovalDto, ComparisonDto, Paginated } from '@tb/shared';
import { apiDownload, apiGet, apiGetPage, apiPatch, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Evaluation, recommendation and approval (plan 09).
 *
 * There is no vendor hook in this file and there must not be: a vendor who could
 * read the comparison would learn every rival's price.
 */

export const useComparison = (tenderId: string | undefined) =>
  useQuery({
    queryKey: qk.tenders.comparison(tenderId ?? ''),
    queryFn: () => apiGet<ComparisonDto>(`/tenders/${tenderId}/comparison`),
    enabled: !!tenderId,
  });

/** Scoring, opening and recommending all move the same three caches. */
const useEvaluationInvalidation = () => {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: qk.tenders.all });
    queryClient.invalidateQueries({ queryKey: qk.approvals.all });
  };
};

/** Opens the sealed bids. Irreversible, and the audit row names who did it. */
export const useOpenBids = (tenderId: string | undefined) => {
  const invalidate = useEvaluationInvalidation();
  return useMutation({
    mutationFn: () => apiPost(`/tenders/${tenderId}/evaluation/open`, {}),
    onSuccess: invalidate,
  });
};

/** Re-runs scoring after a manual mark changes. */
export const useRecalculate = (tenderId: string | undefined) => {
  const invalidate = useEvaluationInvalidation();
  return useMutation({
    mutationFn: () => apiPost(`/tenders/${tenderId}/evaluation/recalculate`, {}),
    onSuccess: invalidate,
  });
};

/**
 * Manual criteria only, 0–10 in half marks. Scored per quotation rather than per
 * tender, so no tender id is needed — the invalidation is tender-wide anyway.
 */
export const useScoreQuotation = () => {
  const invalidate = useEvaluationInvalidation();
  return useMutation({
    mutationFn: ({
      quotationId,
      scores,
      note,
    }: {
      quotationId: string;
      scores: Record<string, number>;
      note?: string;
    }) => apiPatch(`/quotations/${quotationId}/scores`, { scores, note }),
    onSuccess: invalidate,
  });
};

/**
 * Nominating a winner. The justification is long on purpose: it lands in the
 * audit log under the officer's name, and an off-rank choice needs 100
 * characters rather than 50 (plan 09).
 */
export const useRecommend = (tenderId: string | undefined) => {
  const invalidate = useEvaluationInvalidation();
  return useMutation({
    mutationFn: ({ quotationId, justification }: { quotationId: string; justification: string }) =>
      apiPost(`/tenders/${tenderId}/recommend`, { quotationId, justification }),
    onSuccess: invalidate,
  });
};

export async function downloadComparison(tenderId: string, reference: string): Promise<void> {
  const blob = await apiDownload(`/tenders/${tenderId}/comparison/export`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `comparison-${reference.replace(/\//g, '-')}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                  */
/* -------------------------------------------------------------------------- */

export const useApprovals = (params: Record<string, string | number>) =>
  useQuery<Paginated<ApprovalDto>>({
    queryKey: qk.approvals.list(params),
    queryFn: () => apiGetPage<ApprovalDto>('/approvals', { params }),
  });

export const useApproval = (id: string | undefined) =>
  useQuery({
    queryKey: qk.approvals.detail(id ?? ''),
    queryFn: () => apiGet<ApprovalDetailDto>(`/approvals/${id}`),
    enabled: !!id,
  });

export const useDecideApproval = (id: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ decision, comment }: { decision: 'APPROVED' | 'REJECTED'; comment?: string }) =>
      apiPost(`/approvals/${id}/decide`, { decision, comment }),
    // An approved award creates a purchase order in the same transaction
    // (plan 10), so the PO caches have to go too.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.approvals.all });
      queryClient.invalidateQueries({ queryKey: qk.tenders.all });
      queryClient.invalidateQueries({ queryKey: qk.purchaseOrders.all });
      queryClient.invalidateQueries({ queryKey: qk.invoices.all });
      queryClient.invalidateQueries({ queryKey: qk.payments.all });
    },
  });
};
