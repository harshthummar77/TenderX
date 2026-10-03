import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { CURRENCY_SYMBOL } from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatIndianNumber, sanitizeMoneyInput, toMoneyString } from '@/lib/format';
import { fieldClass } from '@/components/ui/input';

export interface MoneyInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  /** Always a string. "811792.80", never 811792.8. */
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  allowNegative?: boolean;
  /** Hide the ₹ prefix where the column header already says the currency. */
  showSymbol?: boolean;
}

/**
 * The money field (plan 16 §5).
 *
 * Three rules it exists to enforce:
 *  - The value is a STRING from keystroke to request body. No `Number()`, no
 *    `parseFloat`, no float arithmetic — "811792.80" survives a round trip
 *    unchanged, which a float cannot promise at invoice scale.
 *  - Indian grouping on blur, raw digits while focused. Grouping as you type
 *    fights the caret; grouping on blur is what makes a column readable.
 *  - Mono, tabular, right-aligned, so a column of rupee figures lines up (§4).
 *
 * `onBlur` normalises to fixed-2 ("8.5" → "8.50"), which is exactly what the
 * server's money regex accepts, so no form has to remember to pad.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onChange, invalid, allowNegative = false, showSymbol = true, className, onFocus, onBlur, ...props },
  ref,
) {
  const [focused, setFocused] = useState(false);

  const display = focused
    ? value
    : value === ''
      ? ''
      : formatIndianNumber(toMoneyString(value), 2);

  return (
    <div className="relative">
      {showSymbol && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-muted"
        >
          {CURRENCY_SYMBOL}
        </span>
      )}
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={display}
        aria-invalid={invalid || undefined}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          if (value !== '') onChange(toMoneyString(value));
          onBlur?.(event);
        }}
        onChange={(event) => {
          const sanitized = sanitizeMoneyInput(event.target.value);
          onChange(allowNegative ? sanitized : sanitized.replace('-', ''));
        }}
        className={cn(
          fieldClass(invalid),
          'h-9 font-mono tabular-nums text-right',
          showSymbol && 'pl-7',
          className,
        )}
        {...props}
      />
    </div>
  );
});
