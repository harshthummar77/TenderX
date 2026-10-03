import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle } from 'lucide-react';
import {
  acceptInvitationSchema,
  PASSWORD_MIN_LENGTH,
  ROLE_LABELS,
  type AcceptInvitationInput,
} from '@tb/shared';
import { applyFieldErrors, formErrorMessage } from '@/lib/forms';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { FormField } from '@/components/form/FormField';
import { AuthLayout, FormError } from '@/features/auth/components/AuthLayout';
import { useAcceptInvitation, useInvitationPreview } from '@/features/auth/api';

/**
 * Accept an invitation (`/accept-invite/:token`, matching the URL
 * `invitation.service` emails).
 *
 * The preview call is what makes this screen trustworthy: before typing a
 * password the invitee sees which company invited them and as what role. Staff
 * accounts are only ever created this way — the email and the role come from the
 * invitation, not from this form, so an invitee cannot promote themselves.
 */
export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const preview = useInvitationPreview(token);
  const accept = useAcceptInvitation(token);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<AcceptInvitationInput>({
    resolver: zodResolver(acceptInvitationSchema),
    defaultValues: { fullName: '', password: '', phone: '' },
  });

  if (preview.isLoading) {
    return (
      <AuthLayout title="Checking your invitation">
        <div className="flex justify-center py-6">
          <Spinner size="lg" />
        </div>
      </AuthLayout>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <AuthLayout
        title="This invitation cannot be used"
        footer={
          <Link to="/login" className="text-primary hover:underline">
            Go to sign in
          </Link>
        }
      >
        <div className="flex flex-col items-center py-4 text-center">
          <AlertCircle aria-hidden className="mb-3 size-6 text-danger" />
          <p className="text-sm text-text">The link has expired, been used, or been revoked.</p>
          <p className="mt-1 text-xs text-muted">
            Ask whoever invited you to send a new invitation.
          </p>
        </div>
      </AuthLayout>
    );
  }

  const invitation = preview.data;

  const onSubmit = form.handleSubmit((values) => {
    setFormError(null);
    accept.mutate(
      { ...values, phone: values.phone || undefined },
      {
        onSuccess: () => navigate('/dashboard', { replace: true }),
        onError: (error) => {
          if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
        },
      },
    );
  });

  return (
    <AuthLayout
      title="Set up your account"
      subtitle={
        <>
          {invitation.partyName ?? 'TenderBridge'} invited <strong>{invitation.email}</strong> as{' '}
          {ROLE_LABELS[invitation.role]}. This invitation expires{' '}
          {formatDateTime(invitation.expiresAt)}.
        </>
      }
    >
      <FormError message={formError} />

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="Full name" name="fullName" required>
          <Input autoComplete="name" autoFocus {...form.register('fullName')} />
        </FormField>

        <FormField
          label="Password"
          name="password"
          required
          hint={`At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a digit.`}
        >
          <Input type="password" autoComplete="new-password" {...form.register('password')} />
        </FormField>

        <FormField label="Phone" name="phone" hint="Optional. 10-digit Indian mobile.">
          <Input inputMode="tel" maxLength={10} {...form.register('phone')} />
        </FormField>

        <Button type="submit" className="w-full" loading={accept.isPending}>
          Create my account
        </Button>
      </form>
    </AuthLayout>
  );
}
