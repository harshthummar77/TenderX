import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@tb/shared';
import { applyFieldErrors, formErrorMessage } from '@/lib/forms';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/form/FormField';
import { AuthLayout, FormError } from '@/features/auth/components/AuthLayout';
import { useLogin } from '@/features/auth/api';

/**
 * Sign in.
 *
 * `loginSchema` is the server's own schema from `@tb/shared` — one schema, two
 * consumers (01 §2). The client cannot drift from the password policy, because
 * there is only one copy of it.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const login = useLogin();
  const [formError, setFormError] = useState<string | null>(null);

  // Where the guard sent us from, so a deep link survives the detour through login.
  const from =
    (location.state as { from?: string } | null)?.from ?? searchParams.get('from') ?? '/dashboard';

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFormError(null);
    login.mutate(values, {
      onSuccess: () => navigate(from, { replace: true }),
      onError: (error) => {
        // A 401 here is "invalid email or password" — deliberately not told which.
        if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
      },
    });
  });

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Use the email your organization or buyer invited."
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="text-primary hover:underline">
            Register an organization or vendor
          </Link>
        </>
      }
    >
      <FormError message={formError} />

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="Email" name="email" required>
          <Input
            type="email"
            autoComplete="email"
            autoFocus
            placeholder="priya@meridian.example"
            {...form.register('email')}
          />
        </FormField>

        <FormField label="Password" name="password" required>
          <Input type="password" autoComplete="current-password" {...form.register('password')} />
        </FormField>

        <Button type="submit" className="w-full" loading={login.isPending}>
          Sign in
        </Button>

        <div className="text-center">
          <Link to="/forgot-password" className="text-xs text-muted hover:text-primary hover:underline">
            Forgot your password?
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}
