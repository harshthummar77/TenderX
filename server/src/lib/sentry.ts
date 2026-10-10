import * as Sentry from '@sentry/node';
import { APP_VERSION } from '../config/app.js';
import { env } from '../config/env.js';

/**
 * Error reporting (plan 19 §6).
 *
 * Off unless `SENTRY_DSN` is set, which is the normal state in development and
 * test — `captureError` then does nothing and nobody has to care. Production
 * sets the DSN on Render and gets the same errors the log already has, grouped
 * and with a release attached.
 *
 * Two deliberate choices:
 *
 * - **No request bodies, no PII.** An error report from this app would
 *   otherwise be a convenient place to find a bid amount or a bank account.
 *   The `requestId` tag is the join key: find the event, then grep the log for
 *   the same id to get the full, already-redacted context.
 * - **Only 5xx.** A 403 or a 422 is the application working correctly; sending
 *   those would bury the real failures and burn the free quota in a day.
 */

const dsn = env.SENTRY_DSN;

export const sentryEnabled = Boolean(dsn);

export function initSentry(): void {
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: env.NODE_ENV,
    // Render injects the deployed commit; fall back to the package version so a
    // release is always tagged with something.
    release: env.RENDER_GIT_COMMIT ?? `tenderbridge@${APP_VERSION}`,
    sendDefaultPii: false,
    // Errors only. Tracing would sample every request and this is a free tier.
    tracesSampleRate: 0,
    beforeSend(event) {
      delete event.request?.data;
      delete event.request?.cookies;
      if (event.request?.headers) delete event.request.headers.authorization;
      return event;
    },
  });
}

/** Report a server-side failure. Safe to call when Sentry is off. */
export function captureError(err: unknown, requestId: string): void {
  if (!dsn) return;

  Sentry.withScope((scope) => {
    scope.setTag('requestId', requestId);
    Sentry.captureException(err);
  });
}
