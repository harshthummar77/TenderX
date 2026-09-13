import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { isTest } from '../config/env.js';

const failure: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest, // rate limits would make the test suite order-dependent
  handler: (req: Request, res) =>
    res.status(429).json({
      success: false,
      error: { code: 'rate_limited', message: 'Too many requests, try again shortly' },
      requestId: req.id,
    }),
};

/** Blanket limit on the whole API. */
export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  ...failure,
});

/** Tighter limit for credential endpoints — applied in plan 03. */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  ...failure,
});
