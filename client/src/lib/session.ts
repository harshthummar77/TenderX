import type { MeDto } from '@tb/shared';
import { apiGet, apiPost, refreshAccessToken } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

/**
 * The auth lifecycle (plan 16 §3). Split out from `api.ts` so the API client
 * stays a leaf: this file is allowed to know about both HTTP and the store.
 */

/**
 * Boot sequence. Get this wrong and the app flashes the login screen on every
 * hard refresh, which is the single most noticeable rough edge in a demo.
 *
 *  1. `status` starts at 'loading' and `App` renders a full-page spinner.
 *  2. One POST /auth/refresh — the httpOnly cookie IS the persistence mechanism.
 *  3. Success: the store holds a token and a user, status 'authenticated'.
 *  4. Failure: status 'anonymous'.
 *  5. Only then are the routes rendered, so no guard ever sees 'loading'.
 *
 * `refreshAccessToken` already stores the session (it carries the full `SessionDto`),
 * so there is no second /auth/me call on the happy path.
 */
export function bootstrapSession(): Promise<void> {
  // Idempotent: React 19's StrictMode runs mount effects twice in development,
  // and two boot refreshes with one cookie is exactly the token-reuse pattern
  // plan 03 punishes by revoking the whole family.
  bootPromise ??= runBootstrap();
  return bootPromise;
}

let bootPromise: Promise<void> | null = null;

async function runBootstrap(): Promise<void> {
  const token = await refreshAccessToken();
  if (!token) {
    useAuthStore.getState().clear();
    return;
  }

  // The refresh response carries the user, but re-reading /auth/me costs one
  // request and catches the case where the party was suspended since the last
  // token was issued.
  try {
    const user = await apiGet<MeDto>('/auth/me');
    useAuthStore.getState().setSession(token, user);
  } catch {
    useAuthStore.getState().clear();
  }
}

/**
 * Revoke this device's refresh token and drop the in-memory one. The guards
 * then render `<Navigate to="/login">` on the next commit — no page reload, so
 * the query cache is dropped by `clearQueryCache` rather than by the browser.
 */
export async function logout(): Promise<void> {
  try {
    await apiPost('/auth/logout');
  } catch {
    // A failed logout still logs the user out locally; the token expires on its own.
  } finally {
    useAuthStore.getState().clear();
    bootPromise = null;
  }
}

/** "Sign out everywhere" — revokes every refresh token the user holds. */
export async function logoutEverywhere(): Promise<void> {
  try {
    await apiPost('/auth/logout-all');
  } finally {
    useAuthStore.getState().clear();
    bootPromise = null;
  }
}
