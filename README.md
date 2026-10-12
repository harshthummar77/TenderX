# TenderBridge

A multi-tenant source-to-pay procurement platform. **Sealed-bid tenders** →
**weighted evaluation** → **approval with separation of duties** →
**GST-compliant purchase order** → **partial deliveries and GRNs** → **vendor
invoice cleared by three-way match** → **payment with TDS and retention** →
**hash-chained audit log** closing the tender when the last invoice is paid.

Built as a final-year project. The architectural and scope decisions behind it
are in [`docs/architecture.md`](docs/architecture.md) and
[`docs/decisions/`](docs/decisions/README.md).

## Demo

Live: _<fill in Vercel URL after deploying>_

Four roles, same password `Demo@12345`:

| Role | Email |
|---|---|
| Platform admin | `admin@tenderbridge.dev` |
| Buyer org admin | `admin@meridian.test` |
| Buyer officer | `officer@meridian.test` |
| Vendor | `v1@acme.test` |

The 10-minute walkthrough is in [`docs/demo.md`](docs/demo.md). First call
after idle is slow (Render + Neon both suspend on the free tier); hit
`/api/v1/ready` once a minute before using.

## What makes it non-trivial

Each is a design decision with a test:

| | |
|---|---|
| **Sealed bidding** | `sealing.spec.ts` — zero bid amounts reachable before the deadline, including to the buyer |
| **Weighted evaluation** | `scoring.spec.ts` — null-rating path, raw → normalised × weight |
| **Separation of duties** | `sod.spec.ts` — the officer who recommended cannot approve |
| **Three-way match** | `match.spec.ts` — PO ✓ GRN ✓ price ✓ quantity ✗, with a non-overridable quantity exception |
| **GST engine** | `tax.spec.ts` — CGST+SGST for intra-state, IGST for inter-state, decimal-perfect |
| **TDS-aware payments** | `payment.spec.ts` — net cash out = gross − TDS; settlement still closes the invoice |
| **Hash-chained audit** | `audit.spec.ts` — `UPDATE` affects 0 rows; `verifyAuditChain` detects edits |
| **Multi-tenancy** | `isolation.spec.ts` — cross-tenant reads return 404, not 403 |

## Stack

| Layer | Choice |
|---|---|
| Server | Node 22 LTS, TypeScript (ESM), Express 5, Prisma 6 |
| Database | Neon serverless Postgres (branches: `main` / `dev` / `test`) |
| Client | Vite 6, React 19, TanStack Query 5, Tailwind 4 |
| Shared | Zod schemas, enums and types compiled to `shared/dist` |
| Hosting | Render (API, Singapore), Vercel (client), Neon (DB, Singapore) — all free tier |

## Local setup

```bash
git clone https://github.com/harshthummar77/TenderX.git
cd "Tender X"

# Create a Neon project with a dev branch. Copy both URLs into server/.env.
cp server/.env.example server/.env
#   DATABASE_URL=postgresql://…-pooler.<region>.aws.neon.tech/…?sslmode=require&pgbouncer=true&connection_limit=10
#   DIRECT_URL=postgresql://…<region>.aws.neon.tech/…?sslmode=require
#   JWT_ACCESS_SECRET=<48 random bytes>
#   JWT_REFRESH_SECRET=<48 different bytes>

npm install
npm run db:migrate              # applies migrations to the dev branch
npm run db:seed -- --reset      # loads the demo dataset
npm run dev                     # api on :4000, client on :5173
```

Generate the two JWT secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

## Documentation

| Document | Answers |
|---|---|
| [`architecture.md`](docs/architecture.md) | why the system is shaped like this |
| [`decisions/`](docs/decisions/README.md) | six ADRs for the choices that shaped the code |
| [`api.md`](docs/api.md) | every endpoint (generated — `npm run docs:api`) |
| [`business-rules.md`](docs/business-rules.md) | the 30+ enforced rules, each with error code and test |
| [`access-control.md`](docs/access-control.md) | the permission matrix |
| [`data-dictionary.md`](docs/data-dictionary.md), [`er-diagram.md`](docs/er-diagram.md) | the schema |
| [`demo.md`](docs/demo.md) | the 10-minute demo script |
| [`testing.md`](docs/testing.md) | how the suite is organised, how to add a fixture |
| [`security.md`](docs/security.md), [`security-review.md`](docs/security-review.md) | every control, and the 10-point review results |
| [`deployment.md`](docs/deployment.md), [`runbook.md`](docs/runbook.md) | how it reaches Render, Vercel and Neon; what to do when something breaks |
| [`performance.md`](docs/performance.md) | measured latency, the bundle budget, cold start |
| [`cut-list.md`](docs/cut-list.md), [`submission-gate.md`](docs/submission-gate.md), [`viva.md`](docs/viva.md) | project-management artefacts |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | all three workspaces in watch mode |
| `npm run build` | shared → server → client |
| `npm run build:shared` | **the fix for every stale-types / `Cannot find module '@tb/shared'` error** |
| `npm run typecheck` | `tsc -b --noEmit` across all three |
| `npm run lint` | eslint |
| `npm run check:conventions` | greps for the three conventions no eslint rule replaces |
| `npm run test:unit` | fast, no database, ~200 tests in 2 s |
| `npm run test:integration` | HTTP against the real app, Neon `test` branch |
| `npm run db:migrate` | `prisma migrate dev` (uses `DIRECT_URL`) |
| `npm run db:seed` | idempotent demo seed |
| `npm run db:seed -- --reset` | truncate every table, then seed |
| `npm run docs:api` | regenerate `docs/api.md` from the live router |

## Health

```text
GET /api/v1/health   liveness, no DB hit  — Render pings this
GET /api/v1/ready    readiness, SELECT 1  — call this a minute before a demo
```

Neon and Render both suspend when idle. `/ready` wakes them; `/health`
deliberately does not touch the database, so pinging it cannot burn the Neon
compute allowance.

## Conventions

- Money: `Decimal(18,2)` in Postgres, `decimal.js` in services, **string** over
  the wire. Never a JS `number`, never `parseFloat`.
- Layering: `route → controller → service → prisma`. Controllers never touch
  Prisma; services never touch `req` / `res`.
- Every error carries a stable `code`. Every state change writes an
  `ActivityLog` row in the same transaction.
- `process.env` is read in exactly one file: `server/src/config/env.ts`.

Enforced by [`server/scripts/check-conventions.mjs`](server/scripts/check-conventions.mjs),
run in CI.

## Testing

Two projects (`server/vitest.workspace.ts`):

- `unit` — pure engines (tax, pricing, scoring, match, sealing, state
  machines, GSTIN). No database. ~200 tests in 2 seconds.
- `integration` — supertest against the real Express app, one Neon `test`
  branch, files run serially (they share the schema and truncate between
  files).

See [`docs/testing.md`](docs/testing.md).

## Roadmap

The deliberate scope reductions and the design for a v2 live in
[`plans/_v2_enterprise/`](plans/_v2_enterprise/) and in
[ADR-006](docs/decisions/ADR-006-scope-reductions.md). Named, not vague:
e-invoicing / IRN integration, split awards, contract and rate-card
management, budget-vs-commitment control, real payment rails.

## Licence

MIT.
