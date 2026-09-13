import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { isTest } from '../config/env.js';

/**
 * express-rate-limit with the default in-process store. One API instance means
 * no shared store is needed — adding Redis for this is exactly the
 * over-engineering 00 §3 rules out.
 */
const base: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest, // rate limits would make the test suite order-dependent
  handler: (req: Request, res) => {
    res.status(429).json({
      success: false,
      error: { code: 'rate_limited', message: 'Too many requests, try again shortly' },
      requestId: req.id,
    });
  },
};

/** Blanket limit on the whole API. */
export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  ...base,
});

/** 10 sign-in attempts per IP per 15 minutes (03 §7). */
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  ...base,
});

/** 5 registrations per IP per hour — self-signup is the cheapest thing to abuse. */
export const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  ...base,
});

/**
 * 3 reset requests per hour, keyed by **email** rather than IP: the thing being
 * protected is a person's inbox, not the network path.
 */
export const forgotPasswordRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  ...base,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : null;
    return email ?? req.ip ?? 'unknown';
  },
});

/** 10 invitation acceptances per IP per 15 minutes. */
export const acceptInviteRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  ...base,
});
