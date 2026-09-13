import pino from 'pino';
import { env, isProd, isTest } from '../config/env.js';

/**
 * Never log a password, a raw token, or a cookie (03 §8). Exported so the test
 * suite asserts against the real list rather than a copy of it.
 */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.token',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.refreshToken',
  '*.accessToken',
  '*.tokenHash',
  '*.token',
  'admin.password',
];

/**
 * One logger for the process. Structured and greppable; every request line
 * carries the request id assigned by requestContext.
 */
export const logger = pino({
  level: isTest ? 'silent' : isProd ? 'info' : 'debug',
  base: { env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: redactPaths, censor: '[redacted]' },
});
