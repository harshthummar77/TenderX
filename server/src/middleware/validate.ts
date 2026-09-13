import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';

interface ValidateSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Express 5 forwards a thrown error automatically, so the ZodError lands in
 * errorHandler with no try/catch anywhere in the route. This is why we use
 * Express 5.
 *
 * Every object schema ends with `.strict()`, so unknown keys are rejected
 * rather than passed through to Prisma.
 */
export const validate =
  (schema: ValidateSchemas) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (schema.params) req.params = schema.params.parse(req.params);
    // req.query is getter-only in Express 5 — the parsed value goes here.
    if (schema.query) req.validatedQuery = schema.query.parse(req.query);
    if (schema.body) req.body = schema.body.parse(req.body);
    next();
  };

/** Typed accessor so controllers do not repeat the cast. */
export const validatedQuery = <T>(req: Request): T => req.validatedQuery as T;
