import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  AcceptInvitationInput,
  InvitationPreviewDto,
  LoginInput,
  MeDto,
  RegisterOrganizationInput,
  RegisterVendorInput,
  SessionDto,
} from '@tb/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import { useAuthStore } from '@/stores/authStore';

/**
 * Typed hooks for the auth module. Components never touch `api` directly
 * (plan 16 §6) — which is what keeps the "store the session" step from being
 * forgotten on one of the four endpoints that return one.
 */

const useSessionMutation = <TInput>(endpoint: string) => {
  const setSession = useAuthStore((state) => state.setSession);

  return useMutation({
    mutationFn: (input: TInput) => apiPost<SessionDto>(endpoint, input),
    // The refresh cookie is set by the response; only the access token and the
    // user need storing, and both live in memory.
    onSuccess: (session) => setSession(session.accessToken, session.user),
  });
};

export const useLogin = () => useSessionMutation<LoginInput>('/auth/login');

export const useRegisterOrganization = () =>
  useSessionMutation<RegisterOrganizationInput>('/auth/register/organization');

export const useRegisterVendor = () =>
  useSessionMutation<RegisterVendorInput>('/auth/register/vendor');

/** Always resolves, whether or not the email exists — the server does not say. */
export const useForgotPassword = () =>
  useMutation({
    mutationFn: (email: string) => apiPost<{ message: string }>('/auth/forgot-password', { email }),
  });

export const useResetPassword = () =>
  useMutation({
    mutationFn: (input: { token: string; password: string }) =>
      apiPost<{ message: string }>('/auth/reset-password', input),
  });

/** Who invited whom, and to what role — shown before the invitee sets a password. */
export const useInvitationPreview = (token: string | undefined) =>
  useQuery({
    queryKey: qk.invitations.preview(token ?? ''),
    queryFn: () => apiGet<InvitationPreviewDto>(`/invitations/${token}`),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  });

export const useAcceptInvitation = (token: string | undefined) => {
  const setSession = useAuthStore((state) => state.setSession);

  return useMutation({
    mutationFn: (input: AcceptInvitationInput) =>
      apiPost<SessionDto>(`/invitations/${token}/accept`, input),
    onSuccess: (session) => setSession(session.accessToken, session.user),
  });
};

export const useUpdateMe = () => {
  const setUser = useAuthStore((state) => state.setUser);

  return useMutation({
    mutationFn: (input: { fullName?: string; phone?: string | null }) =>
      apiPatch<MeDto>('/auth/me', input),
    onSuccess: (user) => setUser(user),
  });
};

export const useChangePassword = () =>
  useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      apiPost<{ message: string }>('/auth/change-password', input),
  });
