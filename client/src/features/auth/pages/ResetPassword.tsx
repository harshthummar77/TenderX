import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { PASSWORD_MIN_LENGTH, passwordSchema } from '@tb/shared';
import { applyFieldErrors, formErrorMessage } from '@/lib/forms';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/form/FormField';
import { toast } from '@/components/ui/toast';
import { AuthLayout, FormError } from '@/features/auth/components/AuthLayout';
import { useResetPassword } from '@/features/auth/api';

/**
 * Set a new password from an emailed link (`/reset-password/:token`, matching the
 * URL `auth.service` sends).
 *
 * The confirmation field is client-only — the server has no use for it, and the
 * password rule itself is the shared `passwordSchema`, not a second copy.
 */
const schema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Both passwords must match',
  });

type Values = z.infer<typeof schema>;

export function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const reset = useResetPassword();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  const onSubmit = form.handleSubmit((values) => {
    if (!token) {
      setFormError('This reset link is incomplete. Request a new one.');
      return;
    }

    setFormError(null);
    reset.mutate(
      { token, password: values.password },
      {
        onSuccess: () => {
          // Every session was revoked server-side, so signing in again is the only path.
          toast.success('Password updated', 'Sign in with your new password.');
          navigate('/login', { replace: true });
        },
        onError: (error) => {
          if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
        },
      },
    );
  });

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle={`At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a digit.`}
      footer={
        <Link to="/login" className="text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      <FormError message={formError} />

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="New password" name="password" required>
          <Input type="password" autoComplete="new-password" autoFocus {...form.register('password')} />
        </FormField>

        <FormField label="Confirm new password" name="confirmPassword" required>
          <Input type="password" autoComplete="new-password" {...form.register('confirmPassword')} />
        </FormField>

        <Button type="submit" className="w-full" loading={reset.isPending}>
          Update password
        </Button>
        <p className="text-center text-xs text-muted">
          Updating your password signs you out everywhere else.
        </p>
      </form>
    </AuthLayout>
  );
}
