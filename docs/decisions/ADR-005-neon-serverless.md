# ADR-005 — Neon serverless Postgres: branches, pooled vs direct, autosuspend

## Context

The project needs three isolated database environments (dev, test, production),
a free hosting path, and point-in-time restore. Local Postgres meets none of
those on a developer laptop running Windows; a managed Postgres with three
instances is well outside the free tier.

## Decision

Neon serverless Postgres, with a **branch per environment** on one free
project:

- `dev` for day-to-day work (`server/.env`)
- `test` for the integration suite (`server/.env.test`) — guarded by a
  truncation check that refuses to run outside this branch
- `main` for production, pointed at by Render

Prisma takes two connection strings:

- `DATABASE_URL` — the **pooled** endpoint (`-pooler` in the hostname),
  pgbouncer in transaction mode, with `connection_limit=10`. Used by every
  live query.
- `DIRECT_URL` — the **direct** endpoint. Used by `prisma migrate deploy`
  because pgbouncer transaction mode breaks `CREATE RULE` and other DDL that
  needs session state.

**Autosuspend** is accepted as a cost. The Neon compute sleeps after a few
minutes idle; Render free dynos sleep after 15. A cold start is 30–40 seconds.
That shaped three decisions:

1. The scheduler runs **every 15 minutes**, not every minute. A one-minute
   poll keeps the compute awake 24/7 and burns the free monthly hours.
2. Tender deadlines close **lazily on read** (close-on-read), not purely by
   polling: the sweep catches tenders nobody looked at, but the user who opens
   a stale tender does not see a stale status.
3. The warm-up procedure is in the runbook. `GET /ready` wakes both halves of
   the stack; a demo starts with one of those by hand, one minute early.

## Consequences

- Point-in-time restore is a UI click, zero infrastructure.
- Testing migrations in CI costs nothing: the test branch is empty and small.
- The region matters: Render and Neon must be in the same region or every
  query crosses continents. `render.yaml` pins Singapore; the project found
  this out the hard way (ADR-005 was written after a Render service
  accidentally landed in Oregon and `/dashboard` took 2 seconds instead of
  200 ms).
- A branch is one project — moving regions means a new project, which is why
  the deployment doc separates "create branch" from "copy strings".
