import helmet from 'helmet';
import { env, isProd } from '../config/env.js';

/**
 * Security headers (plan 19 §5).
 *
 * `helmet()` with its defaults was already mounted; this replaces it with an
 * explicit policy, because the default CSP does not know about this app's two
 * cross-origin facts: the API answers a client on another origin, and images
 * come back from Cloudinary.
 *
 * The API serves JSON, not HTML, so its own CSP is mostly belt and braces — the
 * directives that matter here are `frameAncestors` and `objectSrc`, which hold
 * even on an error page. The client's CSP is Vercel's to set; this one is what
 * `curl -I` on the API shows.
 */

/** Where the browser is allowed to send credentialed requests. */
const API_ORIGIN = env.API_URL;

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // No 'unsafe-eval' and no 'unsafe-inline' for scripts: the acceptance
      // check greps for exactly that.
      scriptSrc: ["'self'"],
      // Tailwind ships real stylesheets, but the PDF renderer and a handful of
      // inline style attributes need this one.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
      connectSrc: ["'self'", API_ORIGIN],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  // A year, and only meaningful over TLS — Render terminates it.
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  frameguard: { action: 'deny' },
  // The API is called by a browser on another origin; the default
  // `same-origin` would block those reads.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});
