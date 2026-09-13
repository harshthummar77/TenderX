# TenderBridge

Multi-tenant source-to-pay procurement platform. Sealed-bid tenders → weighted evaluation →
approval with separation of duties → GST-compliant purchase order → partial deliveries and GRNs →
vendor invoice cleared by three-way match → payment with TDS and retention → hash-chained audit log.

Architecture and scope decisions: [`docs/architecture.md`](docs/architecture.md).
Build order: `plans/00_MASTER_PLAN.md` → `plans/01` … `plans/20`.

## Stack

| Layer | Choice |
|---|---|
| Server | Node.js 22 LTS, TypeScript (ESM), Express 5, Prisma 6 |
| Database | Neon Postgres (branches: `main` / `dev` / `test`) |
| Client | Vite 6, React 19, TanStack Query 5, Tailwind 4 |
| Shared | Zod schemas, enums and types compiled to `shared/dist` |

## Getting started

```bash
npm install
cp server/.env.example server/.env     # then fill in the Neon connection strings
npm run build:shared
npm run dev
```

`npm run dev` builds `shared`, then starts `shared` (watch), `server` (tsx watch) and `client` (Vite)
together. API on <http://localhost:4000>, client on <http://localhost:5173>.

Generate the two JWT secrets (they must be different):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | all three workspaces in watch mode |
| `npm run build` | shared → server → client |
| `npm run build:shared` | **the fix for every stale-types / `Cannot find module '@tb/shared'` error** |
| `npm run typecheck` | `tsc -b --noEmit` across all three |
| `npm run lint` | eslint |
| `npm test` | vitest (server), runs against the Neon `test` branch |
| `npm run db:migrate` | `prisma migrate dev` (uses `DIRECT_URL`) |
| `npm run db:studio` | Prisma Studio |
| `npm run db:seed` | seed script (plan 20) |

## Health

```text
GET /api/v1/health   liveness, no DB hit  — Render pings this
GET /api/v1/ready    readiness, SELECT 1  — call this a minute before a demo
```

Neon and Render both suspend when idle. `/ready` wakes them; `/health` deliberately does not touch
the database, so pinging it cannot burn the Neon compute allowance.

## Conventions

- Money: `Decimal(18,2)` in Postgres, `decimal.js` in services, **string** over the wire. Never a
  JS `number`, never `parseFloat`.
- Layering: `route → controller → service → prisma`. Controllers never touch Prisma; services never
  touch `req` / `res`.
- Every error carries a stable `code`. Every state change writes an `ActivityLog` row in the same
  transaction.
- `process.env` is read in exactly one file: `server/src/config/env.ts`.
