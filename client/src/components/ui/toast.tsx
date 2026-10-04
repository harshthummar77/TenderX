import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { toApiError } from '@/lib/api';
import { TONE_SOFT, type Tone } from '@/components/ui/badge';

/**
 * Mutation feedback. Every mutation in the app ends in a toast — never a bare
 * `alert()`, which blocks the page and looks like a 2003 intranet.
 *
 * The store is a plain module-level array rather than Zustand on purpose: §1 says
 * the auth store is the ONLY client state, and a toast queue is ephemeral UI, not
 * state anything else reads.
 */

export interface ToastItem {
  id: string;
  tone: Tone;
  title: string;
  description?: string;
  /** Errors stay until dismissed; successes disappear on their own. */
  durationMs: number | null;
}

let items: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => items;

export function dismissToast(id: string) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  items = items.filter((item) => item.id !== id);
  emit();
}

function push(tone: Tone, title: string, description?: string, durationMs?: number | null) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resolved = durationMs === undefined ? (tone === 'danger' ? null : 4000) : durationMs;

  // Three at a time. A loop that fires twenty toasts should not cover the screen.
  items = [...items.slice(-2), { id, tone, title, description, durationMs: resolved }];
  emit();

  if (resolved !== null) timers.set(id, setTimeout(() => dismissToast(id), resolved));
  return id;
}

export const toast = {
  success: (title: string, description?: string) => push('success', title, description),
  error: (title: string, description?: string) => push('danger', title, description),
  warning: (title: string, description?: string) => push('warning', title, description),
  info: (title: string, description?: string) => push('info', title, description),

  /**
   * The error toast every mutation's `onError` uses. Field-level problems are
   * already rendered next to their inputs by the `fieldErrors` bridge, so this
   * only mentions that there are some rather than listing them twice.
   */
  fromError: (error: unknown, fallback = 'Something went wrong') => {
    const apiError = toApiError(error);
    const fieldCount = Object.keys(apiError.fieldErrors).length;
    const description = fieldCount
      ? `${fieldCount} ${fieldCount === 1 ? 'field needs' : 'fields need'} attention.`
      : apiError.requestId
        ? `Reference ${apiError.requestId}`
        : undefined;
    return push('danger', apiError.message || fallback, description);
  },
};

const ICONS: Record<Tone, typeof Info> = {
  success: CheckCircle2,
  danger: XCircle,
  warning: AlertTriangle,
  info: Info,
  primary: Info,
  neutral: Info,
};

/** Mounted once, in `App`. */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2"
    >
      {toasts.map((item) => {
        const Icon = ICONS[item.tone];
        return (
          <div
            key={item.id}
            role="status"
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-md border bg-surface p-3 shadow-lg',
              TONE_SOFT[item.tone],
            )}
          >
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text">{item.title}</p>
              {item.description && <p className="mt-0.5 text-xs text-muted">{item.description}</p>}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismissToast(item.id)}
              className="shrink-0 rounded p-0.5 text-muted hover:bg-subtle hover:text-text"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
