# Security

What is actually built, where it lives, and what was left out on purpose. The
evidence that these controls work is in [security-review.md](security-review.md)
and in the test suite; this file is the map.

## Controls that carry the weight

| Control | Where | Note |
|---|---|---|
| Rotating refresh tokens with reuse detection | `auth.service.ts`, plan 03 | a replayed token revokes the whole family |
| bcrypt cost 12, 5-attempt lockout, constant-shape login responses | `auth.service.ts` | a wrong password and an unknown email are indistinguishable |
| Permission matrix with separation of duties | `shared/src/permissions.ts`, plan 04 | `ORG_OFFICER` can never approve, override or pay |
| Tenant scoping, 404 not 403 | `lib/scope.ts` | a foreign id is *absent*, not *forbidden* — no existence leak |
| Field-level DTOs | `*.serializers.ts`, plan 06 | bank details are never in a public response; the owner sees them masked |
| Sealed bids with hash verification | plan 08 | nothing reads a bid amount before the deadline, including the buyer |
| Server-side recomputation of every money figure | plans 08, 10, 12 | the client's totals are display-only; the server never trusts them |
| Three-way match, duplicate invoice prevention | plan 12 | quantity exceptions cannot be overridden by anyone |
| Append-only, hash-chained audit log | plan 14 | `UPDATE` affects 0 rows; the chain is verifiable end to end |
| Magic-byte file sniffing, SVG ban, signed short-lived download URLs | plan 14 | the extension and the declared MIME type are both ignored |

## Headers

`server/src/middleware/securityHeaders.ts` — `helmet()` with an explicit CSP
rather than the defaults, because the defaults do not know that the client is on
another origin and that images come from Cloudinary.

- `default-src 'self'`, `script-src 'self'` — **no `unsafe-eval`, no
  `unsafe-inline` for scripts**.
- `style-src` allows `unsafe-inline`: the PDF renderer and a few inline style
  attributes need it. Styles cannot execute, so this is the cheap concession.
- `frame-ancestors 'none'` plus `X-Frame-Options: DENY`.
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.
- HSTS one year with subdomains; it only means anything over TLS, which Render
  terminates.
- `upgrade-insecure-requests` in production only, so local HTTP still works.
- `app.disable('x-powered-by')` — no framework banner.

The client's own headers are in `client/vercel.json`. It has no CSP: the API
origin differs per environment and Vercel's static headers cannot read the build
env, so a hardcoded `connect-src` there would be wrong in one environment or
the other. The headers that do not depend on the origin are set.

## Rate limits

In-process (`express-rate-limit`), no Redis. One instance makes that correct;
two would need a shared store, and that is a scaling decision, not a security
one.

| Scope | Window | Limit |
|---|---|---|
| everything | 15 min | 300 |
| `POST /auth/login` | 15 min | 10 |
| registration | 1 h | 5 |
| forgot password | 1 h | 3 |
| accept invitation | 15 min | 10 |

Responses carry `RateLimit-Policy` and `RateLimit` headers, so a client can see
how close it is before it gets a 429.

## Injection

- Prisma parameterises everything. Every raw query in `server/src` uses a tagged
  template with `${}`.
- `$queryRawUnsafe` / `$executeRawUnsafe` appear **nowhere** in `server/src` —
  the only uses are the test truncation helper and the review script, both of
  which build no SQL from input.
- Every Zod object schema ends with `.strict()`, so an unknown key is a 422
  rather than something that reaches Prisma.
- The ten-point review sends `'; DROP TABLE users;--` through search and it comes
  back as a literal, with the table intact.

## Logging

pino to stdout as JSON; Render aggregates. Every line carries `requestId`, and
authenticated lines carry `userId` and `organizationId`.

Redacted at the logger (`lib/logger.ts`), so no call site can leak them:
`req.headers.authorization`, `req.headers.cookie`, `res.headers['set-cookie']`,
`req.body.password`, `.newPassword`, `.currentPassword`, `.token`, and the
wildcards `*.password`, `*.passwordHash`, `*.refreshToken`, `*.accessToken`,
`*.token`, `*.tokenHash`, `*.bankAccountNumber`, `*.bankIfsc`.

Bank details are redacted twice over: pino never prints them, and `lib/audit.ts`
replaces them with `[redacted]` *before* hashing, so even the audit row does not
carry the value — only the fact that it changed.

Stack traces are never in a response body in production; the error handler
returns a code and a message, and the trace goes to the log with the request id.

## Frontend

- The access token lives in memory only — never `localStorage`, never a
  non-httpOnly cookie (plan 16). The refresh cookie is httpOnly and scoped to
  `/api/v1/auth`, so it is never attached to an ordinary API call.
- That cookie is `SameSite=Lax` locally and **`SameSite=None; Secure` in
  production**, because the client (Vercel) and the API (Render) are different
  sites and a Lax cookie is never sent on the cross-site `POST /auth/refresh`.
  `None` widens the cookie's reach, so the controls that keep it safe are the
  narrow `Path`, `httpOnly`, `Secure`, CORS pinned to one origin, and rotation
  with reuse detection — a stolen refresh token is single-use and revokes its
  whole family.
- No `dangerouslySetInnerHTML` anywhere (0 occurrences).
- No `target="_blank"` anywhere, so there is no `rel="noopener"` to forget; if
  one is added later it needs `rel="noopener noreferrer"`.

## Cut on purpose

Each of these was considered and dropped for a stated reason, not missed:

| Not built | Why |
|---|---|
| AES-256-GCM encryption at rest for bank details | Neon encrypts the volume; application-level encryption needs a key-management story this project has nowhere to put, and the field-level DTOs already keep the value out of every response |
| MFA | one user population, no admin console exposed to the internet beyond the app itself; it is the first thing to add if this were real |
| Common-password blocklist | a length and composition rule plus the lockout covers the realistic attack here |
| gitleaks in CI | `.env` is ignored from the first commit and there is one developer; the rotation procedure in the runbook is the control that actually matters |
| SSRF allow-listing | **no user-supplied URL is ever fetched server-side.** That is a design property, not an omission — there is no SSRF surface to allow-list |
| Redis-backed rate limiting | one instance; see above |

## Known weak points

Being honest about these is worth more than pretending they do not exist.

- **One platform admin account, password-only.** Its credentials are the single
  highest-value secret in the system.
- **The in-process rate limiter resets on deploy.** A deploy clears the counters,
  so a determined attacker could reset their budget by waiting for one.
- **`APP_URL` is trusted for email links.** If it is set wrong, invitation links
  point at the wrong host. It is a one-line configuration mistake with a
  phishing-shaped outcome, which is why the deploy checklist ends with it.
- **No per-tenant encryption boundary.** Isolation is enforced in the query
  layer (`scopeToOrg` / `scopeToVendor` / `scopeToParty`), not by the database.
  One missing scope call in a new endpoint would be a cross-tenant leak, which
  is why the suite has isolation tests per module rather than one global check.

## Observability

| Signal | Where it goes |
|---|---|
| Logs | pino JSON to stdout; Render aggregates. Every line has `requestId`; authenticated lines add `userId` and `organizationId` |
| Errors | Sentry, **server side only**, 5xx only, tagged with `requestId`, release from `RENDER_GIT_COMMIT` |
| Uptime | a free monitor on `/api/v1/health`; see the compute-allowance caveat in [deployment.md](deployment.md#neon) |
| System metrics | `GET /api/v1/platform/system`, surfaced on the platform admin dashboard — one probe shared with the dashboard, so the screen and a monitor cannot disagree |

Sentry is in `server/src/lib/sentry.ts` and is **off unless `SENTRY_DSN` is
set** — the normal state locally and in test, where `captureError` is a no-op.
It sends no request bodies, no cookies, no `Authorization` header and no PII:
the `requestId` tag is the join key back to the (already redacted) log line.
Only 5xx is reported, because a 403 or a 422 is the application working
correctly and sending those would bury real failures and burn the free quota.

**The browser SDK was deliberately not added.** `@sentry/react` costs roughly
35 kB gzipped and the client bundle has 24 kB of headroom against the 300 kB
budget ([performance.md](performance.md#bundle)) — so adding it would break a
stated budget to catch errors that the server already reports, with the
`RouteErrorBoundary` handling what the user sees. If client-side reporting
becomes worth it, the honest sequence is: add route-level code splitting first,
then the SDK into the resulting headroom.
