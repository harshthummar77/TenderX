import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * `invalid` is a prop rather than a CSS pseudo-class so React Hook Form's error
 * state and the ring are always the same thing — `:invalid` fires on untouched
 * required inputs and would paint a fresh form red.
 */
export const fieldClass = (invalid?: boolean, className?: string) =>
  cn(
    'w-full rounded-md border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted',
    'transition-colors disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted',
    'focus-visible:outline-2 focus-visible:outline-offset-0',
    invalid
      ? 'border-danger focus-visible:outline-danger'
      : 'border-border focus-visible:outline-primary',
    className,
  );

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(fieldClass(invalid), 'h-9', className)}
      {...props}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 3, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(fieldClass(invalid), 'resize-y', className)}
      {...props}
    />
  );
});
