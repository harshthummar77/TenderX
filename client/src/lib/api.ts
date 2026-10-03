import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ApiResponse, PageMeta, Paginated, SessionDto } from '@tb/shared';
import { useAuthStore } from '@/stores/authStore';

/**
 * The API client. Every screen in the app depends on this file, so the two
 * details that prevent whole classes of bug are spelled out where they happen:
 * single-flight refresh, and never refreshing in response to the refresh call
 * itself.
 *
 * In development `VITE_API_URL` is unset and the Vite proxy forwards /api to
 * :4000, which keeps the refresh cookie first-party. In production it is the
 * deployed API origin and the cookie is cross-site, which is why `withCredentials`
 * is on and the server pins CORS to one exact origin.
 */

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1';

export const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true, // required for the refresh cookie
  headers: { Accept: 'application/json' },
});

/**
 * A second instance with NO interceptors, used for POST /auth/refresh. If the
 * refresh call went through `api`, a 401 from it would trigger a refresh, which
 * would 401, which would trigger a refresh.
 */
const refreshClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: { Accept: 'application/json' },
});

/* -------------------------------------------------------------------------- */
/* Normalised error                                                           */
/* -------------------------------------------------------------------------- */

export interface ApiError {
  status: number;
  /** Stable code from the server envelope: `validation_failed`, `forbidden`, … */
  code: string;
  message: string;
  /**
   * `error.fields[]` flattened to `{ 'organization.gstin': 'Must be a valid GSTIN' }`,
   * which is exactly the shape React Hook Form's `setError` wants.
   */
  fieldErrors: Record<string, string>;
  /** Present on failures; the join key between this screen and the server logs. */
  requestId?: string;
}

const NETWORK_ERROR: Omit<ApiError, 'message'> = {
  status: 0,
  code: 'network_error',
  fieldErrors: {},
};

/** Every rejection the app ever sees is an `ApiError`, including network failures. */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error;

  if (error instanceof AxiosError) {
    const body = error.response?.data as ApiResponse<unknown> | undefined;

    if (!error.response) {
      return {
        ...NETWORK_ERROR,
        message:
          error.code === 'ECONNABORTED'
            ? 'The request timed out. Check your connection and try again.'
            : 'Cannot reach the server. Check your connection and try again.',
      };
    }

    if (body && body.success === false) {
      const fieldErrors: Record<string, string> = {};
      for (const field of body.error.fields ?? []) {
        // First message per path wins: two issues on one input would otherwise
        // flicker, and the first is the one the user has to fix first anyway.
        if (!(field.path in fieldErrors)) fieldErrors[field.path] = field.message;
      }
      return {
        status: error.response.status,
        code: body.error.code,
        message: body.error.message,
        fieldErrors,
        ...(body.requestId ? { requestId: body.requestId } : {}),
      };
    }

    return {
      status: error.response.status,
      code: 'unexpected_response',
      message: error.message || 'The server returned an unexpected response.',
      fieldErrors: {},
    };
  }

  return {
    status: 0,
    code: 'client_error',
    message: error instanceof Error ? error.message : 'Something went wrong.',
    fieldErrors: {},
  };
}

export const isApiError = (error: unknown): error is ApiError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'fieldErrors' in error &&
  'status' in error;

/* -------------------------------------------------------------------------- */
/* Token refresh                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Paths that must never trigger a refresh on 401.
 *
 * Narrower than "anything under /auth": GET /auth/me SHOULD refresh and retry,
 * because it is a normal authenticated read that can hit an expired token like
 * any other. What must not refresh is the refresh itself, and the unauthenticated
 * endpoints where a 401/403 means "wrong password" or "bad token" — refreshing
 * there turns a failed login into an infinite loop.
 */
const NO_REFRESH_PATHS = [
  '/auth/refresh',
  '/auth/login',
  '/auth/register',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/invitations/',
];

const skipsRefresh = (url: string | undefined) =>
  !!url && NO_REFRESH_PATHS.some((path) => url.includes(path));

/** The in-flight refresh, shared by every request that discovers an expired token. */
let refreshing: Promise<string | null> | null = null;

/**
 * **Single-flight.** Six queries fire on a dashboard, the access token is
 * expired, and all six 401 at once. Without the shared promise that is six
 * POST /auth/refresh calls with the same cookie: the first rotates the token
 * and the other five present a now-used token, which trips the reuse detection
 * in plan 03 and revokes the whole family. The user is thrown out and the bug
 * reads as "the app randomly logs me out".
 */
export function refreshAccessToken(): Promise<string | null> {
  refreshing ??= (async () => {
    try {
      const res = await refreshClient.post<ApiResponse<SessionDto>>('/auth/refresh');
      if (!res.data.success) return null;
      const session = res.data.data;
      useAuthStore.getState().setSession(session.accessToken, session.user);
      return session.accessToken;
    } catch {
      return null;
    }
  })().finally(() => {
    refreshing = null;
  });

  return refreshing;
}

/* -------------------------------------------------------------------------- */
/* Interceptors                                                               */
/* -------------------------------------------------------------------------- */

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers = AxiosHeaders.from(config.headers);
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

type RetryConfig = InternalAxiosRequestConfig & { _retry?: boolean };

const redirectToLogin = () => {
  useAuthStore.getState().clear();
  // A guard would normally handle this, but an expired session can be
  // discovered from a mutation deep in a page, where no render is pending.
  // Skipped when already on an auth screen so a failed login cannot loop.
  const path = window.location.pathname;
  if (!path.startsWith('/login')) {
    window.location.href = `/login?from=${encodeURIComponent(path + window.location.search)}`;
  }
};

api.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!(error instanceof AxiosError)) return Promise.reject(toApiError(error));

    const original = error.config as RetryConfig | undefined;

    if (
      error.response?.status === 401 &&
      original &&
      !original._retry &&
      !skipsRefresh(original.url)
    ) {
      original._retry = true;

      const token = await refreshAccessToken();
      if (token) {
        original.headers = AxiosHeaders.from(original.headers);
        original.headers.set('Authorization', `Bearer ${token}`);
        return api(original);
      }

      redirectToLogin();
    }

    return Promise.reject(toApiError(error));
  },
);

/* -------------------------------------------------------------------------- */
/* Typed helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Unwrap the envelope (00 §6) so a feature hook gets the payload, not
 * `response.data.data`. A 2xx with `success: false` cannot happen, but typing it
 * away is cheaper than discovering it at runtime.
 */
function unwrap<T>(response: AxiosResponse<ApiResponse<T>>): T {
  const body = response.data;
  if (!body.success) {
    throw {
      status: response.status,
      code: body.error.code,
      message: body.error.message,
      fieldErrors: {},
      ...(body.requestId ? { requestId: body.requestId } : {}),
    } satisfies ApiError;
  }
  return body.data;
}

export const apiGet = async <T>(url: string, config?: AxiosRequestConfig): Promise<T> =>
  unwrap(await api.get<ApiResponse<T>>(url, config));

/** List endpoints return rows plus `meta`; a paginated hook needs both. */
export async function apiGetPage<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<Paginated<T>> {
  const response = await api.get<ApiResponse<T[]>>(url, config);
  const rows = unwrap(response);
  const meta: PageMeta =
    response.data.success && response.data.meta
      ? response.data.meta
      : { page: 1, limit: rows.length, total: rows.length, pages: 1 };
  return { data: rows, meta };
}

export const apiPost = async <T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> => unwrap(await api.post<ApiResponse<T>>(url, body, config));

export const apiPatch = async <T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> => unwrap(await api.patch<ApiResponse<T>>(url, body, config));

export const apiPut = async <T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> => unwrap(await api.put<ApiResponse<T>>(url, body, config));

/** DELETE answers 204 with no body on most routes, so there is nothing to unwrap. */
export async function apiDelete(url: string, config?: AxiosRequestConfig): Promise<void> {
  await api.delete(url, config);
}

/** CSV and PDF endpoints (plan 15) hand back a Blob, not the envelope. */
export async function apiDownload(url: string, config?: AxiosRequestConfig): Promise<Blob> {
  const response = await api.get<Blob>(url, { ...config, responseType: 'blob' });
  return response.data;
}
