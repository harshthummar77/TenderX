/**
 * Wire types. The envelope defined here is the ONLY shape the API ever returns
 * (00 §6) — the client's API layer is typed against it.
 */

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface ApiFieldError {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  /** Stable, documented code — the join key between docs, tests and UI messages. */
  code: string;
  message: string;
  fields?: ApiFieldError[];
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PageMeta;
}

export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
  requestId?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

/** Money always crosses the wire as a fixed-2 string: "125000.00". */
export type MoneyString = string;

/** Quantities cross the wire as a fixed-3 string: "12.500". */
export type QuantityString = string;

/** ISO-8601 UTC timestamp. */
export type IsoDateTime = string;

export interface HealthPayload {
  status: 'ok';
  uptime: number;
  version: string;
  timestamp: IsoDateTime;
}

export interface ReadyPayload {
  db: 'ok' | 'down';
  responseTimeMs: number;
}
