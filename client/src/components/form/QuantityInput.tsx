import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { formatIndianNumber, sanitizeQtyInput, toQtyString } from '@/lib/format';
import { fieldClass } from '@/components/ui/input';

export interface QuantityInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  /** Fixed-3 string: "12.500". */
  value: string;
  onChange: (value: string) => void;
  /** Shown as a suffix inside the field — "KG", "NOS", "HOUR". */
  unit?: string | null;
  invalid?: boolean;
}

/**
 * Quantities carry three decimals (0.5 kg, 2.25 m), and the unit lives in the
 * field so a GRN row reads "12.500 KG" rather than a bare number next to a
 * header someone has to scroll back to.
 *
 * Same string discipline as `MoneyInput`: a quantity that becomes a float can
 * turn 0.3 into 0.29999999999999998 on the way to a short-receipt check.
 */
export const QuantityInput = forwardRef<HTMLInputElement, QuantityInputProps>(
  function QuantityInput({ value, onChange, unit, invalid, className, onFocus, onBlur, ...props }, ref) {
    const [focused, setFocused] = useState(false);
    const display = focused ? value : value === '' ? '' : formatIndianNumber(toQtyString(value), 3);

    return (
      <div className="relative">
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
            if (value !== '') onChange(toQtyString(value));
            onBlur?.(event);
          }}
          onChange={(event) => onChange(sanitizeQtyInput(event.target.value))}
          className={cn(
            fieldClass(invalid),
            'h-9 font-mono tabular-nums text-right',
            unit && 'pr-12',
            className,
          )}
          {...props}
        />
        {unit && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted"
          >
            {unit}
          </span>
        )}
      </div>
    );
  },
);
