import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { fieldClass } from '@/components/ui/input';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  options?: readonly SelectOption[];
  /** Rendered as a disabled first option, for an optional filter. */
  placeholder?: string;
}

/**
 * A styled native `<select>`.
 *
 * Deliberately not a custom listbox: the native control gets keyboard support,
 * type-ahead and a usable mobile picker for free, and every select in this app
 * is a short list of enum values (status, unit, tax rate) rather than something
 * that needs search or multi-select.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, options, placeholder, children, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(fieldClass(invalid), 'h-9 cursor-pointer appearance-none pr-9', className)}
        {...props}
      >
        {placeholder !== undefined && (
          <option value="">{placeholder}</option>
        )}
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted"
      />
    </div>
  );
});
