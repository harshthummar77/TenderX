import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePaymentInput,
  Paginated,
  PayableDto,
  PaymentDto,
} from '@tb/shared';
import { apiDownload, apiGet, apiGetPage, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * Payments (plan 13).
 *
 * `PAYMENT_RECORD` is an admin permission: an officer can see the register and
 * the payables worklist, and cannot release a rupee (04 §7).
 */

export type PaymentScope = 'buyer' | 'vendor';

export const usePayments = (scope: PaymentScope, params: Record<string, string | number>) =>
  useQuery<Paginated<PaymentDto>>({
    queryKey: qk.payments.list({ scope, ...params }),
    queryFn: () =>
      apiGetPage<PaymentDto>(scope === 'vendor' ? '/vendor/payments' : '/payments', { params }),
  });

export const usePayment = (id: string | undefined) =>
  useQuery({
    queryKey: qk.payments.detail(id ?? ''),
    queryFn: () => apiGet<PaymentDto>(`/payments/${id}`),
    enabled: !!id,
  });

/** The worklist: approved invoices with an outstanding balance, oldest first. */
export const usePayable = (params?: Record<string, string | number>) =>
  useQuery({
    queryKey: qk.payments.payable(params),
    queryFn: () => apiGet<PayableDto>('/payments/payable', { params }),
  });

const usePaymentInvalidation = () => {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: qk.payments.all });
    queryClient.invalidateQueries({ queryKey: qk.invoices.all });
    queryClient.invalidateQueries({ queryKey: qk.approvals.all });
  };
};

export const useCreatePayment = () => {
  const invalidate = usePaymentInvalidation();
  return useMutation({
    mutationFn: (input: CreatePaymentInput) => apiPost<PaymentDto>('/payments', input),
    onSuccess: invalidate,
  });
};

/** The bank came back with a reference: the money actually moved. */
export const useCompletePayment = (id: string | undefined) => {
  const invalidate = usePaymentInvalidation();
  return useMutation({
    mutationFn: (input: { referenceNumber: string; valueDate?: string }) =>
      apiPost<PaymentDto>(`/payments/${id}/complete`, input),
    onSettled: invalidate,
  });
};

export const useFailPayment = (id: string | undefined) => {
  const invalidate = usePaymentInvalidation();
  return useMutation({
    mutationFn: (reason: string) => apiPost<PaymentDto>(`/payments/${id}/fail`, { reason }),
    onSettled: invalidate,
  });
};

export const useCancelPayment = (id: string | undefined) => {
  const invalidate = usePaymentInvalidation();
  return useMutation({
    mutationFn: (reason: string) => apiPost<PaymentDto>(`/payments/${id}/cancel`, { reason }),
    onSettled: invalidate,
  });
};

/** The payment advice PDF the vendor is sent (plan 13 §8). */
export async function downloadPaymentAdvice(id: string, paymentNumber: string): Promise<void> {
  const blob = await apiDownload(`/payments/${id}/advice`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${paymentNumber.replace(/\//g, '-')}.pdf`;
  anchor.click();
  URL.revokeObjectURL(url);
}
