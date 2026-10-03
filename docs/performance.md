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
