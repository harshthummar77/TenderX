import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import {
  fromDateInputValue,
  toDateInputValue,
  toDateTimeInputValue,
} from '@/lib/format';
import { fieldClass } from '@/components/ui/input';

export interface DatePickerProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  /** ISO-8601 UTC, exactly what the API takes and returns. */
  value: string | null | undefined;
  onChange: (iso: string | null) => void;
  mode?: 'date' | 'datetime';
  invalid?: boolean;
  /**
   * For a closing date: a bare date means end of that day, not 00:00, so
   * "closes 15 Oct" gives vendors all of the 15th.
   */
  endOfDay?: boolean;
  min?: string;
  max?: string;
}

/**
 * The native date control, styled.
 *
 * A hand-built calendar popover is a week of work and a keyboard-accessibility
 * liability; the native one is already localised and already keyboard-driven. The
 * part worth owning is the conversion: the input speaks local wall-clock time and
 * the API speaks UTC instants, and getting that wrong moves a tender deadline by
 * five and a half hours.
 */
export const DatePicker = forwardRef<HTMLInputElement, DatePickerProps>(function DatePicker(
  { value, onChange, mode = 'date', invalid, endOfDay = false, min, max, className, ...props },
  ref,
) {
  const inputValue = mode === 'datetime' ? toDateTimeInputValue(value) : toDateInputValue(value);

  return (
    <input
      ref={ref}
      type={mode === 'datetime' ? 'datetime-local' : 'date'}
      value={inputValue}
      min={min ? (mode === 'datetime' ? toDateTimeInputValue(min) : toDateInputValue(min)) : undefined}
      max={max ? (mode === 'datetime' ? toDateTimeInputValue(max) : toDateInputValue(max)) : undefined}
      aria-invalid={invalid || undefined}
      onChange={(event) =>
        onChange(event.target.value ? fromDateInputValue(event.target.value, endOfDay) : null)
      }
      className={cn(fieldClass(invalid), 'h-9', className)}
      {...props}
    />
  );
});
