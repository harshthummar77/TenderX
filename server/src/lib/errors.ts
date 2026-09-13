export interface FieldError {
  path: string;
  message: string;
}

/**
 * Every failure the API returns on purpose is an AppError. `code` is stable and
 * documented — it is the join key between docs/business-rules.md, the test names
 * and the UI's error messages (00 §6).
 */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: FieldError[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const BadRequest = (code: string, m: string, f?: FieldError[]) =>
  new AppError(400, code, m, f);

export const Unauthorized = (m = 'Authentication required') =>
  new AppError(401, 'auth.unauthorized', m);

export const Forbidden = (m = 'You do not have permission') => new AppError(403, 'auth.forbidden', m);

export const NotFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);

export const Conflict = (code: string, m: string) => new AppError(409, code, m);

export const Validation = (fields: FieldError[]) =>
  new AppError(422, 'validation_failed', 'Validation failed', fields);

/** Business rule violation — the most common error in this app. Always give it a stable code. */
export const BusinessRule = (code: string, m: string) => new AppError(422, code, m);

export const TooManyRequests = (m = 'Too many requests') =>
  new AppError(429, 'rate_limited', m);

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
