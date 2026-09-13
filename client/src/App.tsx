import { useEffect, useState } from 'react';
import { SHARED_PACKAGE_VERSION, formatMoney, type ApiResponse, type HealthPayload } from '@tb/shared';

/**
 * Plan 01 smoke screen: proves the Vite dev proxy reaches the API and that the
 * client can import the compiled @tb/shared package. Plan 16 replaces it with
 * the real shell (router, TanStack Query, design system).
 */
export function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/health')
      .then((res) => res.json() as Promise<ApiResponse<HealthPayload>>)
      .then((body) => {
        if (body.success) setHealth(body.data);
        else setError(`${body.error.code}: ${body.error.message}`);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Request failed'));
  }, []);

  return (
    <main className="app">
      <h1>TenderBridge</h1>
      <p>Source-to-pay procurement platform</p>

      <section>
        <h2>API</h2>
        {error && <p role="alert">API unreachable — {error}</p>}
        {!error && !health && <p>Checking…</p>}
        {health && (
          <dl>
            <dt>status</dt>
            <dd>{health.status}</dd>
            <dt>version</dt>
            <dd>{health.version}</dd>
            <dt>uptime</dt>
            <dd>{health.uptime}s</dd>
          </dl>
        )}
      </section>

      <footer>
        <small>
          @tb/shared v{SHARED_PACKAGE_VERSION} · sample amount {formatMoney('125000')}
        </small>
      </footer>
    </main>
  );
}
