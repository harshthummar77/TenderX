import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const SIZES = {
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-6',
  xl: 'size-8',
} as const;

export function Spinner({
  size = 'md',
  className,
  label = 'Loading',
}: {
  size?: keyof typeof SIZES;
  className?: string;
  label?: string;
}) {
  return (
    <Loader2
      role="status"
      aria-label={label}
      className={cn('animate-spin text-muted', SIZES[size], className)}
    />
  );
}

/** The boot screen (plan 16 §3 step 1) and any route-level suspense fallback. */
export function FullPageSpinner({ label = 'Loading TenderX' }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg">
      {/* loader.png is the app loader; if it is missing the spinner stands in. */}
      <img
        src="/loader.png"
        alt=""
        aria-hidden
        className="h-16 w-16 animate-pulse object-contain motion-reduce:animate-none"
        onError={(event) => {
          event.currentTarget.style.display = 'none';
        }}
      />
      <Spinner size="lg" className="text-primary" label={label} />
      <p className="text-sm text-muted">{label}…</p>
    </div>
  );
}
