import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LogOut } from 'lucide-react';
import {
  changePasswordSchema,
  PASSWORD_MIN_LENGTH,
  ROLE_LABELS,
  updateMeSchema,
  type ChangePasswordInput,
} from '@tb/shared';
import { applyFieldErrors, formErrorMessage } from '@/lib/forms';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/data/StatusBadge';
import { FormField, FormGrid } from '@/components/form/FormField';
import { PageHeader } from '@/components/layout/PageHeader';
import { toast } from '@/components/ui/toast';
import { FormError } from '@/features/auth/components/AuthLayout';
import { useChangePassword, useUpdateMe } from '@/features/auth/api';

type ProfileValues = { fullName?: string; phone?: string | null };

/**
 * `/settings/profile` — the one screen every role shares.
 *
 * Email and role are shown but not editable: the email identifies the account
 * and the role is granted by whoever invited them, not chosen here.
 */
export function ProfilePage() {
  const { user, role, partyName, logoutEverywhere } = useAuth();
  const updateMe = useUpdateMe();
  const changePassword = useChangePassword();
  const [profileError, setProfileError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const profileForm = useForm<ProfileValues>({
    resolver: zodResolver(updateMeSchema),
    values: { fullName: user?.fullName ?? '', phone: user?.phone ?? '' },
  });

  const passwordForm = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  const onSaveProfile = profileForm.handleSubmit((values) => {
    setProfileError(null);
    updateMe.mutate(
      { fullName: values.fullName, phone: values.phone || null },
      {
        onSuccess: () => toast.success('Profile updated'),
        onError: (error) => {
          if (!applyFieldErrors(error, profileForm.setError)) {
            setProfileError(formErrorMessage(error));
          }
        },
      },
    );
  });

  const onChangePassword = passwordForm.handleSubmit((values) => {
    setPasswordError(null);
    changePassword.mutate(values, {
      onSuccess: () => {
        passwordForm.reset({ currentPassword: '', newPassword: '' });
        toast.success('Password changed', 'Your other sessions were signed out.');
      },
      onError: (error) => {
        if (!applyFieldErrors(error, passwordForm.setError)) {
          setPasswordError(formErrorMessage(error));
        }
      },
    });
  });

  return (
    <>
      <PageHeader title="My profile" description="Your account, password and sessions." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Account" />
          <CardBody>
            <FieldGrid className="mb-5 grid-cols-2 sm:grid-cols-2">
              <Field label="Email">{user?.email}</Field>
              <Field label="Role">{role ? ROLE_LABELS[role] : '—'}</Field>
              <Field label="Organization / vendor">{partyName ?? '—'}</Field>
              <Field label="Status">
                <StatusBadge status={user?.status} />
              </Field>
              <Field label="Last signed in">{formatDateTime(user?.lastLoginAt)}</Field>
            </FieldGrid>

            <FormError message={profileError} />

            <form onSubmit={onSaveProfile} noValidate>
              <FormGrid>
                <FormField label="Full name" name="fullName" required>
                  <Input {...profileForm.register('fullName')} />
                </FormField>
                <FormField label="Phone" name="phone" hint="10-digit Indian mobile.">
                  <Input inputMode="tel" maxLength={10} {...profileForm.register('phone')} />
                </FormField>
              </FormGrid>

              <div className="mt-4 flex justify-end">
                <Button type="submit" loading={updateMe.isPending}>
                  Save changes
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Password"
            description={`At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a digit.`}
          />
          <CardBody>
            <FormError message={passwordError} />

            <form onSubmit={onChangePassword} className="space-y-4" noValidate>
              <FormField label="Current password" name="currentPassword" required>
                <Input
                  type="password"
                  autoComplete="current-password"
                  {...passwordForm.register('currentPassword')}
                />
              </FormField>

              <FormField
                label="New password"
                name="newPassword"
                required
                hint="Changing it signs out every other device."
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  {...passwordForm.register('newPassword')}
                />
              </FormField>

              <div className="flex justify-end">
                <Button type="submit" loading={changePassword.isPending}>
                  Change password
                </Button>
              </div>
            </form>
          </CardBody>

          <CardFooter className="justify-between">
            <p className="text-xs text-muted">
              Signed in somewhere you do not recognise? End every session.
            </p>
            <Button
              variant="outline"
              size="sm"
              leftIcon={<LogOut className="size-3.5" />}
              onClick={() => void logoutEverywhere()}
            >
              Sign out everywhere
            </Button>
          </CardFooter>
        </Card>
      </div>
    </>
  );
}
