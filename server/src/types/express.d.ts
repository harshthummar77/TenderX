/**
 * Express request augmentation.
 *
 * `validatedQuery` exists because Express 5 made `req.query` a getter — the
 * parsed query cannot be assigned back onto it, so validate() puts the coerced
 * value here and controllers read it from there.
 */
declare global {
  namespace Express {
    interface Request {
      /** Per-request correlation id, set by requestContext and echoed on every error. */
      id: string;
      /** Output of the `query` schema in validate(). Typed per route by the controller. */
      validatedQuery?: unknown;
    }
  }
}

export {};
