import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MailPlus, UserMinus } from 'lucide-react';
import {
  inviteMemberSchema,
  ORG_INVITABLE_ROLES,
  PERMISSIONS as P,
  ROLE_LABELS,
  type InviteMemberInput,
  type MemberDto,
} from '@tb/shared';
import { applyFieldErrors, formErrorMessage } from '@/lib/forms';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/data/EmptyState';
import { StatusBadge } from '@/components/data/StatusBadge';
import { FormField } from '@/components/form/FormField';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { FormError } from '@/features/auth/components/AuthLayout';
import {
  useInvitations,
  useInviteMember,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
  useUpdateMember,
} from '@/features/organization/api';

const ROLE_OPTIONS = ORG_INVITABLE_ROLES.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
}));

/**
 * `/settings/members` — who works here, and what each of them may do.
 *
 * Only the two organization roles can be invited: handing out PLATFORM_ADMIN or
 * VENDOR from inside a tenant would cross the tenancy boundary, so the server's
 * `ORG_INVITABLE_ROLES` is also the list this select renders.
 */
export function MembersPage() {
  const { can, user } = useAuth();
  const members = useMembers();
  const invitations = useInvitations();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<MemberDto | null>(null);

  const updateMember = useUpdateMember();
  const removeMember = useRemoveMember();
  const revokeInvitation = useRevokeInvitation();

  if (!can(P.ORG_MEMBER_MANAGE)) return <Forbidden />;

  const rows = members.data ?? [];
  const pendingInvites = invitations.data ?? [];

  return (
    <>
      <PageHeader
        title="Members"
        description="Officers and administrators in your organization."
        actions={
          <Button leftIcon={<MailPlus className="size-3.5" />} onClick={() => setInviteOpen(true)}>
            Invite member
          </Button>
        }
      />

      <Card className="mb-4">
        <CardHeader title="Members" description={`${rows.length} with a login`} />
        {members.isLoading ? (
          <CardBody>
            <Skeleton className="h-32 w-full" />
          </CardBody>
        ) : rows.length === 0 ? (
          <EmptyState title="No members yet" message="Invite an officer to get started." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Status</TH>
                <TH>Last signed in</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((member) => {
                const isSelf = member.id === user?.id;
                return (
                  <TR key={member.id}>
                    <TD>
                      {member.fullName}
                      {isSelf && <span className="ml-1.5 text-xs text-muted">(you)</span>}
                    </TD>
                    <TD className="text-muted">{member.email}</TD>
                    <TD>
                      <Select
                        aria-label={`Role for ${member.fullName}`}
                        className="h-8 w-44 text-xs"
                        value={member.role}
                        // An admin demoting themselves could leave the org with
                        // nobody who can approve anything.
                        disabled={isSelf || updateMember.isPending}
                        options={ROLE_OPTIONS}
                        onChange={(event) =>
                          updateMember.mutate(
                            { userId: member.id, role: event.target.value as 'ORG_ADMIN' },
                            {
                              onSuccess: () => toast.success('Role updated'),
                              onError: (error) => toast.fromError(error),
                            },
                          )
                        }
                      />
                    </TD>
                    <TD>
                      <StatusBadge status={member.status} />
                    </TD>
                    <TD className="text-muted">{formatRelative(member.lastLoginAt, 'Never')}</TD>
                    <TD className="text-right">
                      {!isSelf && (
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={updateMember.isPending}
                            onClick={() =>
                              updateMember.mutate(
                                {
                                  userId: member.id,
                                  status: member.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
                                },
                                {
                                  onSuccess: () => toast.success('Member updated'),
                                  onError: (error) => toast.fromError(error),
                                },
                              )
                            }
                          >
                            {member.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${member.fullName}`}
                            onClick={() => setRemoving(member)}
                          >
                            <UserMinus className="size-3.5 text-danger" />
                          </Button>
                        </div>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Pending invitations"
          description="Invitations that have not been accepted yet."
        />
        {invitations.isLoading ? (
          <CardBody>
            <Skeleton className="h-20 w-full" />
          </CardBody>
        ) : pendingInvites.length === 0 ? (
          <EmptyState title="No pending invitations" message="Everyone invited has signed up." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Expires</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {pendingInvites.map((invitation) => (
                <TR key={invitation.id}>
                  <TD>{invitation.email}</TD>
                  <TD>{ROLE_LABELS[invitation.role as 'ORG_ADMIN'] ?? invitation.role}</TD>
                  <TD className="text-muted">{formatDateTime(invitation.expiresAt)}</TD>
                  <TD className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        revokeInvitation.mutate(invitation.id, {
                          onSuccess: () => toast.success('Invitation revoked'),
                          onError: (error) => toast.fromError(error),
                        })
                      }
                    >
                      Revoke
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this member?"
        message={
          <>
            {removing?.fullName} will lose access immediately. Their past actions stay on the audit
            trail.
          </>
        }
        confirmLabel="Remove member"
        requireReason={false}
        loading={removeMember.isPending}
        onConfirm={() => {
          if (!removing) return;
          removeMember.mutate(removing.id, {
            onSuccess: () => {
              toast.success('Member removed');
              setRemoving(null);
            },
            onError: (error) => toast.fromError(error),
          });
        }}
      />
    </>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invite = useInviteMember();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<InviteMemberInput>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: '', fullName: '', role: 'ORG_OFFICER' },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFormError(null);
    invite.mutate(
      { ...values, fullName: values.fullName || undefined },
      {
        onSuccess: () => {
          toast.success('Invitation sent', `${values.email} has seven days to accept.`);
          form.reset();
          onClose();
        },
        onError: (error) => {
          if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
        },
      },
    );
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite a member"
      description="They set their own password from the emailed link."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={invite.isPending} onClick={onSubmit}>
            Send invitation
          </Button>
        </>
      }
    >
      <FormError message={formError} />

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="Email" name="email" required>
          <Input type="email" autoFocus {...form.register('email')} />
        </FormField>

        <FormField label="Full name" name="fullName" hint="Optional — they can set it themselves.">
          <Input {...form.register('fullName')} />
        </FormField>

        <FormField
          label="Role"
          name="role"
          required
          hint="Officers run the process; administrators authorise money."
        >
          <Select options={ROLE_OPTIONS} {...form.register('role')} />
        </FormField>
      </form>
    </Dialog>
  );
}
