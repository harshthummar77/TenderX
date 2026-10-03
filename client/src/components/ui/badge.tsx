import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Semantic tones, not colour names. A component asks for `danger`, never for
 * "red" — which is what lets dark mode be a token swap and keeps `REJECTED` the
 * same colour on all eleven screens that render it.
 */
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/** Tinted fill with a matching border — readable in both themes at 11px. */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-subtle text-muted border-border',
  primary: 'bg-primary/10 text-primary border-primary/25',
  success: 'bg-success/12 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/35',
  danger: 'bg-danger/12 text-danger border-danger/30',
  info: 'bg-info/12 text-info border-info/30',
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-muted',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** A filled dot before the label — what makes a dense status column scannable. */
  dot?: boolean;
  size?: 'sm' | 'md';
}

export function Badge({
  tone = 'neutral',
  dot = false,
  size = 'sm',
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        TONE_SOFT[tone],
        className,
      )}
      {...props}
    >
      {dot && <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />}
      {children}
    </span>
  );
}
