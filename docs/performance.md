# Performance

Measurement method and results for the two heaviest read paths: the role
dashboard and the spend report (plan 15 §5).

## Why there is no cache

None, deliberately. At this data volume the dashboard is a handful of indexed
aggregates, and a cache would add invalidation complexity for no measurable
gain. *"I measured it and it didn't need one"* is a better answer than an
unnecessary Redis — but it is only a better answer if the measurement exists,
which is what this file is for.

## What to measure

Two queries carry the page weight:

1. **`GET /api/v1/dashboard`** — one batch of aggregates per role. The buyer
   variant is the heaviest: eight counts, five sums, two `groupBy` calls and the
   six-month spend series.
2. **`GET /api/v1/reports/spend?groupBy=month`** — the `generate_series` spine
   with three correlated subqueries per month.

## Method

Run against a realistically seeded database — plan 20 provides the seed. The
numbers below are meaningless against an empty or test-sized dataset, which is
why this file records the method now and the results after seeding.

```bash
# 1. Seed realistic volume
npm run db:seed -w server

# 2. Time the endpoints end to end, warm
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w '%{time_total}\n' \
    -H "Authorization: Bearer $TOKEN" \
    http://localhost:4000/api/v1/dashboard
done
```

Then `EXPLAIN ANALYZE` the two SQL statements directly. The spend series is the
one worth inspecting, because the correlated subqueries are the part most likely
to need an index:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT to_char(m, 'YYYY-MM') AS month,
       (SELECT COALESCE(SUM(p."grossAmount"), 0) FROM payments p
         WHERE p."organizationId" = '<org-uuid>'::uuid
           AND p.status = 'COMPLETED'::"PaymentStatus"
           AND date_trunc('month', p."paidAt") = m) AS paid
FROM generate_series(
  date_trunc('month', now() - interval '11 months'),
  date_trunc('month', now()),
  interval '1 month'
) AS m
ORDER BY m;
```

## Indexes already in place

From plan 02, and the reason these queries are expected to be cheap:

| Table | Index | Used by |
|---|---|---|
| `tenders` | `(organizationId, status)` | dashboard tile counts, tender report |
| `tenders` | `(status, bidSubmissionDeadline)` | closing-soon, deadline sweeper |
| `purchase_orders` | `(organizationId, status)` | open PO value, committed spend |
| `purchase_orders` | `(vendorId, status)` | vendor dashboard, top vendors |
| `invoices` | `(organizationId, status)` | invoices-to-verify, ageing, invoiced spend |
| `invoices` | `(purchaseOrderId)` | closure cascade, fulfilment |
| `payments` | `(organizationId, status)` | paid spend, payment tiles |
| `payments` | `(invoiceId)` | settlement |
| `quotations` | `(tenderId, status)` | bid counts, evaluation |
| `activity_logs` | `sequence` unique | chain verification, recent activity |

## Candidate indexes, if measurement shows they are needed

Not added speculatively — an unused index costs write throughput and buys
nothing. Add only with a before/after number recorded below.

- `payments (organizationId, paidAt)` — if the monthly series scans.
- `invoices (organizationId, dueDate)` — if the ageing buckets scan.
- `invoices (organizationId, matchStatus)` — if the exception report scans.

## Results

> **Pending.** These require the plan 20 seed; measuring against the current
> test-sized dataset would produce numbers that say nothing about production
> behaviour, and recording those would be worse than recording none.

| Query | Before | After | Index added |
|---|---|---|---|
| `GET /dashboard` (buyer) | — | — | — |
| `GET /reports/spend?groupBy=month` | — | — | — |

Target from plan 15 §8: `GET /dashboard` under 400 ms against the seeded
dataset.

---

# Deployment budget (plan 19 §7)

| Target | Budget | Measured | Verdict |
|---|---|---|---|
| API p95, list endpoints | < 400 ms | 830–1550 ms **from a dev laptop in India against Neon in Singapore** | over budget locally; see below |
| API p95, dashboard | < 500 ms | 2091 ms median, same conditions | over budget locally |
| PDF generation | < 1.5 s | not measured | — |
| Client first contentful paint | < 2 s | not measured (needs the deployed URL) | — |
| Client initial JS, gzipped | < 300 kB | **275.6 kB** | **within budget** |

## The latency story, honestly

Measured on 2026-10-09, dev laptop → Neon `dev` branch in `ap-southeast-1`,
six requests per endpoint, median and max:

```
/dashboard                      median 2091ms  max 3351ms
/tenders?limit=20               median 1551ms  max 1626ms
/invoices?limit=20              median  828ms  max  832ms
/payments/payable?limit=20      median  988ms  max 1185ms
/reports/spend?groupBy=month    median  379ms  max  383ms
/platform/system                median  764ms  max 1289ms
```

The control measurement is the one that explains all of them:
`GET /api/v1/ready`, which does nothing but `SELECT 1`, takes **375 ms**. That
is the network round trip from here to Singapore. So:

- `/reports/spend` at 379 ms is **one** round trip — a single query. It is the
  fastest endpoint in the app and it is also the most complex SQL in the app,
  which tells you the SQL is not the problem.
- `/dashboard` at 2091 ms is roughly 5–6 round trips of pure latency.
- `/tenders` at 1551 ms is about 4.

**None of this is query cost.** In production the API runs on Render in
Singapore alongside the database, where a round trip is single-digit
milliseconds rather than 375. The same 5–6 round trips then cost tens of
milliseconds, not two seconds. That is why `render.yaml` pins
`region: singapore` — co-location is the whole optimisation, and getting it
wrong would be the single most expensive configuration mistake available.

**This is unverified until deployed.** The honest statement for the report is:
the local numbers are dominated by one measured constant (375 ms per round
trip), the query work itself is a few milliseconds, and the budget should be
re-measured against the Render URL before claiming it is met.

If it still misses after deployment, the fix is fewer round trips per page, not
faster SQL: batch the dashboard's independent reads into one `Promise.all`
wave — `/dashboard` is already partly parallel, so the remaining 5–6 trips mean
some reads still wait on earlier ones.

## Bundle

```
dist/assets/index-*.css    36.05 kB │ gzip:   7.24 kB
dist/assets/forms-*.js     85.47 kB │ gzip:  23.60 kB
dist/assets/query-*.js     91.61 kB │ gzip:  25.57 kB
dist/assets/react-*.js    104.53 kB │ gzip:  35.23 kB
dist/assets/index-*.js    692.32 kB │ gzip: 191.18 kB
                                      ─────────────
                            total JS  gzip: 275.58 kB   (budget 300 kB)
```

`manualChunks` in `client/vite.config.ts` splits React, the TanStack libraries
and the form stack out of the app bundle. It does not reduce the first download
— the total is the same — it reduces every subsequent one, because those three
chunks only change on an npm upgrade while the app chunk changes on every
deploy. Without the split, a one-line fix makes every visitor re-download React.

**Route-level code splitting was deliberately not done.** The budget is met with
29 kB to spare, and lazy routes would add a `Suspense` boundary and a loading
state to every screen for a first-paint gain that nothing is currently asking
for. The note to the next person: the app chunk at 191 kB gzipped is where to
look first if the budget is ever exceeded, and splitting the evaluation and
reporting screens would be the obvious first cut.

**`vite-bundle-visualizer` was not run** — it is not an installed dependency,
and `vite build` already reports per-chunk gzipped sizes, which is the number
the budget is written against. One finding from reading the manifest instead:
`recharts` is in `client/package.json` but imported nowhere, so Rollup already
tree-shakes it out of the bundle entirely. It costs install time, not bundle
size. Removing it from `package.json` is a safe cleanup; it needs an
`npm install` to refresh the lockfile, so it is not done here.

## Cold start

| Stage | Cost |
|---|---|
| Render free instance asleep (15 min idle) | ~20–30 s to boot |
| Neon compute asleep (a few min idle) | ~1 s on the first query |
| Both cold | 30–40 s |

Mitigation and the warm-up procedure are in
[runbook.md](runbook.md#warming-up-before-a-demo). This is measured locally only
for the Neon half (375 ms warm, ~1 s after suspend); the Render half is quoted
from Render's documented free-tier behaviour and must be measured once the
service exists.
