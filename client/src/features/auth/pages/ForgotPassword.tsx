import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import { forgotPasswordSchema } from '@tb/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/form/FormField';
import { AuthLayout } from '@/features/auth/components/AuthLayout';
import { useForgotPassword } from '@/features/auth/api';

type Values = { email: string };

/**
 * Request a reset link.
 *
 * The confirmation is identical whether or not the email is registered — same as
 * the server's response (plan 03). Saying "no such account" here turns the form
 * into a way to test which emails exist.
 */
export function ForgotPasswordPage() {
  const forgot = useForgotPassword();

  const form = useForm<Values>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  if (forgot.isSuccess) {
    return (
      <AuthLayout
        title="Check your email"
        footer={
          <Link to="/login" className="text-primary hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col items-center py-4 text-center">
          <MailCheck aria-hidden className="mb-3 size-6 text-success" />
          <p className="text-sm text-text">
            If that email is registered, a reset link is on its way.
          </p>
          <p className="mt-1 text-xs text-muted">The link is valid for one hour.</p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We will email you a link to set a new one."
      footer={
        <Link to="/login" className="text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form
        onSubmit={form.handleSubmit((values) => forgot.mutate(values.email))}
        className="space-y-4"
        noValidate
      >
        <FormField label="Email" name="email" required>
          <Input type="email" autoComplete="email" autoFocus {...form.register('email')} />
        </FormField>

        <Button type="submit" className="w-full" loading={forgot.isPending}>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}
