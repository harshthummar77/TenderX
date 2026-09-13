import pino from 'pino';
import { env, isProd, isTest } from '../config/env.js';

/**
 * One logger for the process. Structured and greppable; every request line
 * carries the request id assigned by requestContext.
 */
export const logger = pino({
  level: isTest ? 'silent' : isProd ? 'info' : 'debug',
  base: { env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.refreshToken',
      '*.token',
    ],
    censor: '[redacted]',
  },
});
