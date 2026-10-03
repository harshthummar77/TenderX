import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui/card';

/**
 * The frame for the five unauthenticated screens. Calm and narrow — the same
 * "instrument panel" restraint as the rest of the app (§4), no hero gradient.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  wide = false,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Registration needs two columns; signing in does not. */
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-10">
      <div className={cn('w-full', wide ? 'max-w-3xl' : 'max-w-sm')}>
        <div className="mb-5 text-center">
          <p className="text-base font-semibold tracking-tight text-text">TenderBridge</p>
          <p className="text-xs text-muted">Source-to-pay procurement</p>
        </div>

        <Card>
          <div className="px-5 py-5">
            <h1 className="text-base font-semibold text-text">{title}</h1>
            {subtitle && <p className="mt-1 text-xs text-muted">{subtitle}</p>}
            <div className="mt-5">{children}</div>
          </div>
        </Card>

        {footer && <div className="mt-4 text-center text-xs text-muted">{footer}</div>}
      </div>
    </div>
  );
}

/** A form-level failure that belongs to no single input ("Invalid email or password"). */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
    >
      <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
