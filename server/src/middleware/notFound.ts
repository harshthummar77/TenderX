import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';

/** Unmatched route → the same envelope as every other failure. */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'route_not_found', `Cannot ${req.method} ${req.originalUrl}`));
}
