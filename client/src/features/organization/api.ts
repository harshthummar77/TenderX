import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InviteMemberInput,
  MemberDto,
  OrganizationDto,
  OrgSettings,
  UpdateMemberInput,
  UpdateOrgInput,
  UpdateSettingsInput,
} from '@tb/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/**
 * The buyer organization's own record (plan 05). Everything here is `/me` —
 * cross-tenant reads belong to the platform module.
 */

export const useMyOrganization = () =>
  useQuery({
    queryKey: qk.organizations.detail('me'),
    queryFn: () => apiGet<OrganizationDto>('/organizations/me'),
  });

export const useOrgSettings = () =>
  useQuery({
    queryKey: qk.organizations.settings,
    queryFn: () => apiGet<OrgSettings>('/organizations/me/settings'),
  });

export const useUpdateOrganization = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrgInput) => apiPatch<OrganizationDto>('/organizations/me', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.organizations.all }),
  });
};

export const useUpdateOrgSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) =>
      apiPatch<OrgSettings>('/organizations/me/settings', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.organizations.all }),
  });
};

export const useMembers = () =>
  useQuery({
    queryKey: qk.organizations.members('me'),
    queryFn: () => apiGet<MemberDto[]>('/organizations/me/members'),
  });

export const useInviteMember = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteMemberInput) =>
      apiPost<{ id: string; email: string }>('/organizations/me/members/invite', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.organizations.members('me') });
      queryClient.invalidateQueries({ queryKey: qk.invitations.all });
    },
  });
};

export const useUpdateMember = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, ...input }: UpdateMemberInput & { userId: string }) =>
      apiPatch<MemberDto>(`/organizations/me/members/${userId}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.organizations.members('me') }),
  });
};

export const useRemoveMember = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiDelete(`/organizations/me/members/${userId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.organizations.members('me') }),
  });
};

/** Pending invitations, so an admin can see who has not accepted yet. */
export const useInvitations = () =>
  useQuery({
    queryKey: qk.invitations.list(),
    queryFn: () =>
      apiGet<{ id: string; email: string; role: string; expiresAt: string; createdAt: string }[]>(
        '/invitations',
      ),
  });

export const useRevokeInvitation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/invitations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.invitations.all }),
  });
};
