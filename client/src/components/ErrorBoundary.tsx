import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { AlertOctagon, RefreshCw } from 'lucide-react';
import { isApiError } from '@/lib/api';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * The card the user sees instead of a white screen.
 *
 * The `requestId` is the feature. Every API failure carries the id the server
 * logged the same request under (see `middleware/errorHandler.ts`), so "it broke"
 * becomes a string you paste into the logs and land on the exact stack — which
 * during a live demo is the difference between a shrug and an answer.
 */
function ErrorCard({
  title,
  message,
  requestId,
  onRetry,
  stack,
}: {
  title: string;
  message: string;
  requestId?: string;
  onRetry?: () => void;
  stack?: string;
}) {
  return (
    <Card className="mx-auto mt-10 max-w-xl">
      <div className="px-6 py-8">
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-danger/10 text-danger">
          <AlertOctagon className="size-5" />
        </div>

        <h1 className="text-base font-semibold text-text">{title}</h1>
        <p className="mt-2 text-sm text-muted">{message}</p>

        {requestId && (
          <div className="mt-4 rounded-md border border-border bg-subtle px-3 py-2">
            <p className="text-xs text-muted">Reference</p>
            <p className="font-mono text-xs text-text select-all">{requestId}</p>
          </div>
        )}

        <div className="mt-5 flex items-center gap-2">
          {onRetry && (
            <Button variant="primary" size="sm" onClick={onRetry} leftIcon={<RefreshCw className="size-3.5" />}>
              Try again
            </Button>
          )}
          <ButtonLink to="/dashboard" variant="outline" size="sm">
            Go to dashboard
          </ButtonLink>
        </div>

        {/* Only ever populated in development — the API strips stacks in production. */}
        {stack && import.meta.env.DEV && (
          <pre className="mt-4 max-h-64 overflow-auto rounded-md bg-subtle p-3 font-mono text-[11px] text-muted">
            {stack}
          </pre>
        )}
      </div>
    </Card>
  );
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors anywhere below it. React has no hook equivalent, so
 * this stays a class component — the only one in the app.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No telemetry service in scope (00 §3); the console is where a developer looks.
    if (import.meta.env.DEV) console.error('Unhandled render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const apiError = isApiError(error) ? error : null;

    return (
      <ErrorCard
        title="Something went wrong"
        message={
          apiError?.message ??
          'This screen hit an unexpected error. Reloading usually clears it; if it does not, the reference below identifies the request in the server logs.'
        }
        requestId={apiError?.requestId}
        stack={error.stack}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}

/**
 * The router's `errorElement`. Catches what the boundary above cannot: a failed
 * route loader, and the 404 for an unmatched path.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <ErrorCard
        title={error.status === 404 ? 'That page does not exist' : `Error ${error.status}`}
        message={error.statusText || 'The route could not be loaded.'}
      />
    );
  }

  const apiError = isApiError(error) ? error : null;

  return (
    <ErrorCard
      title="Something went wrong"
      message={apiError?.message ?? 'This page could not be loaded.'}
      requestId={apiError?.requestId}
      stack={error instanceof Error ? error.stack : undefined}
      onRetry={() => window.location.reload()}
    />
  );
}
