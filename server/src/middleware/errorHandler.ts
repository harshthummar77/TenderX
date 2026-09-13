import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProd } from '../config/env.js';
import { AppError, type FieldError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

interface Formatted {
  status: number;
  code: string;
  message: string;
  fields?: FieldError[];
}

const zodFields = (error: ZodError): FieldError[] =>
  error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

/** `meta.target` names the column(s) that collided on a unique constraint. */
const conflictTarget = (error: Prisma.PrismaClientKnownRequestError): string | undefined => {
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.join(', ');
  return typeof target === 'string' ? target : undefined;
};

function format(err: unknown): Formatted {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, fields: err.fields };
  }

  if (err instanceof ZodError) {
    return {
      status: 422,
      code: 'validation_failed',
      message: 'Validation failed',
      fields: zodFields(err),
    };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = conflictTarget(err);
      return {
        status: 409,
        code: 'duplicate',
        message: target ? `${target} already exists` : 'Record already exists',
        fields: target ? [{ path: target, message: 'already exists' }] : undefined,
      };
    }
    if (err.code === 'P2025') {
      return { status: 404, code: 'not_found', message: 'Resource not found' };
    }
    if (err.code === 'P2003') {
      return { status: 409, code: 'foreign_key', message: 'Related record does not exist' };
    }
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return { status: 400, code: 'malformed_json', message: 'Request body is not valid JSON' };
  }

  return { status: 500, code: 'internal_error', message: 'Something went wrong' };
}

/**
 * The last middleware, and the only place a failure response is ever built.
 * A 500 never leaks a stack trace in production; in development it is logged.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const { status, code, message, fields } = format(err);

  const log = logger.child({ requestId: req.id, code, status });
  if (status >= 500) {
    log.error({ err }, 'Unhandled error');
  } else {
    log.warn({ msg: message }, 'Request failed');
  }

  res.status(status).json({
    success: false,
    error: {
      code,
      message,
      ...(fields?.length ? { fields } : {}),
      ...(!isProd && status >= 500 && err instanceof Error ? { stack: err.stack } : {}),
    },
    requestId: req.id,
  });
}
