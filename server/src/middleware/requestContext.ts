import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Assigns req.id before anything else logs. The same id is echoed in every
 * error body and in the X-Request-Id header, so a user-reported failure can be
 * grepped straight out of the logs.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.id = incoming && incoming.length <= 64 ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
