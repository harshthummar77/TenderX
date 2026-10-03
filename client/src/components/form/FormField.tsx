import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { useFormContext } from 'react-hook-form';
import { cn } from '@/lib/cn';

/**
 * Label, hint, error and the wiring between them.
 *
 * Pass `name` inside a React Hook Form `<FormProvider>` and the error is read
 * straight from form state — which is what makes the `fieldErrors` bridge in
 * `lib/api.ts` pay off: a 422 from the server calls `setError(path, …)` and the
 * message appears under the right input with no per-form code.
 */
export interface FormFieldProps {
  label: ReactNode;
  /** Dotted path, exactly as the server reports it: `organization.gstin`, `items.0.rate`. */
  name?: string;
  /** Overrides the form-state lookup. */
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/** `errors['items.0.rate']` is not a real key — walk the path. */
function errorAt(errors: unknown, path: string): string | undefined {
  let node: any = errors;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  const message = node?.message;
  return typeof message === 'string' ? message : undefined;
}

export function FormField({
  label,
  name,
  error,
  hint,
  required = false,
  children,
  className,
}: FormFieldProps) {
  const generatedId = useId();
  // Null outside a <FormProvider>, which is fine: `error` is then explicit.
  const form = useFormContext();
  const resolvedError = error ?? (name && form ? errorAt(form.formState.errors, name) : undefined);

  const inputId = name ? `field-${name}` : generatedId;
  const describedBy = [resolvedError && `${inputId}-error`, hint && `${inputId}-hint`]
    .filter(Boolean)
    .join(' ');

  // Wire id/aria onto the control without every call site repeating them.
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: (children.props as Record<string, unknown>).id ?? inputId,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': resolvedError ? true : undefined,
        invalid: (children.props as Record<string, unknown>).invalid ?? !!resolvedError,
      })
    : children;

  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-text">
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-danger">
            *
          </span>
        )}
      </label>

      {control}

      {hint && !resolvedError && (
        <p id={`${inputId}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
      {resolvedError && (
        <p id={`${inputId}-error`} role="alert" className="mt-1 text-xs text-danger">
          {resolvedError}
        </p>
      )}
    </div>
  );
}

/** Two- or three-column form grid, so a registration page is not a tall ribbon. */
export function FormGrid({
  columns = 2,
  children,
  className,
}: {
  columns?: 1 | 2 | 3;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid gap-4',
        columns === 1 && 'grid-cols-1',
        columns === 2 && 'grid-cols-1 sm:grid-cols-2',
        columns === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {children}
    </div>
  );
}
