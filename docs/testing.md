# Testing

About 230 tests. No Docker, no local Postgres: the integration suite runs
against the Neon **`test`** branch, so a clean clone needs nothing beyond
`npm i`.

## Running them

```bash
npm run test:unit          # no database, ~2s, safe to watch
npm run test:integration   # the Neon test branch, single-file
npm test                   # both projects
npm run check:conventions  # the three self-review greps (plan 18 §6)
```

`npm run test:unit -w server -- --watch` is the loop to keep open while writing
an engine. **Never leave the integration suite in watch mode** — it keeps the
Neon compute awake and eats the monthly allowance (00 §7B).

Before the first integration run, or after a schema change:

```bash
npm run db:deploy:test     # prisma migrate deploy against .env.test
npm run db:status:test     # what the test branch currently has
```

## The two projects

`server/vitest.workspace.ts` defines them.

| Project | What is in it | Database | Parallel |
|---|---|---|---|
| `unit` | the pure engines: tax, pricing, scoring, match, sealing, payable, GSTIN, shared utils, state machines | none | yes |
| `integration` | everything else — supertest against the real app | Neon `test` | **no** |

Membership is a filename list in the workspace file, not a folder split: the
suites were written beside their modules, and moving thirty files would churn
every import for nothing. **A spec belongs in `unit` only if nothing it imports
reaches Prisma** — add it to the `UNIT` array when you write one.

Integration tests run one file at a time on purpose. They share a single
database and truncate every table between files; two workers would delete each
other's fixtures mid-test.

## Adding a fixture

Scenario helpers live in `server/test/helpers/`, and each builds on the last, so
a test reads as business language rather than setup:

| Helper | Gives you |
|---|---|
| `actors.ts` — `makeOrganization`, `makeVendor`, `makeUser`, `seedOrgWithData` | parties and authenticated agents (`actor.authHeader`) |
| `bidding.ts` — `bidFixture`, `publishTender`, `placeBid`, `closeBidding`, `openedForEvaluation`, `scoreAllBids` | a tender with real sealed bids on it |
| `fulfilment.ts` | an accepted purchase order, deliveries, goods receipts |
| `payable.ts` | an approved invoice ready to pay |
| `db.ts` — `truncateAll`, `disconnect` | the `beforeEach` / `afterAll` pair every integration file needs |

The fixtures build **through the API**, not by seeding rows. That keeps them
honest: every guard in the upstream plan has to pass for the fixture to build at
all, so a regression fails loudly instead of being mocked past.

A new integration file starts:

```ts
beforeEach(truncateAll);
afterAll(disconnect);
```

## Test-only endpoints

Mounted only when `NODE_ENV === 'test'` (`server/src/modules/_test/test.routes.ts`),
and each handler re-checks, so a mistake in `routes.ts` cannot expose them.
There is no authentication on them — which is exactly why they must never reach
a deployed environment.

```http
POST /api/v1/_test/advance-time      { "hours": 72, "tenderId": "…" }
POST /api/v1/_test/run-job/:name     deadline-sweep | po-response | email-retry | vendor-stats
```

`advance-time` does not fake the clock — nothing here takes an injectable `now`.
It shifts the tender's deadlines backwards instead, which reaches the same state
through the same code path a real expiry uses. Use it rather than sleeping:
`waitForTimeout` on deadline logic is how a suite becomes flaky.

The cron registry is disabled under test (`registerJobs` returns early), so a
test that wants a sweep has to ask for it.

## Resetting the test branch

Truncation happens automatically between files. To start from nothing:

```bash
npm run db:deploy:test     # migrations only; data is left alone
```

For a genuinely clean branch, reset it in the Neon console (branch → Reset from
parent) and re-run `db:deploy:test`. `prisma migrate reset` is **not** wired to
`.env.test` — running it would target the dev branch.

Two guards in `helpers/db.ts` stop a truncation going to the wrong place:
`NODE_ENV` must be `test`, and `DATABASE_URL` must name the test endpoint. They
exist for the day somebody edits an env file by hand.

## What the suite is for

Not coverage. Targeted tests where being wrong costs money or marks:

- **Money engines** — GST per line and per document, quotation pricing, payment
  arithmetic, amount-in-words, fiscal-year numbering.
- **Tenant isolation** — one test per resource, GET / PATCH / list.
- **Sealed bids** — every buyer endpoint, before the deadline, asserting no
  amount leaks.
- **State machines** — `stateMachines.spec.ts` is table-driven over the
  transition maps, so every legal move is admitted and *every* pair that is not
  on the map throws. Adding a status to an enum without adding it to a map fails
  here rather than in week 6.
- **Separation of duties** — an officer is refused the admin's actions, and a
  requester cannot approve their own request.
- **Concurrency** — three suites, over real HTTP with `Promise.allSettled`:
  `publish.concurrency` (20 parallel publishes → 20 unique gapless numbers),
  `grn.concurrency` (never over-receive a line), `payment.concurrency` (never
  overpay an invoice).

### Known debt the checker tracks

`check:conventions` carries an allowlist with a reason per entry
(`server/scripts/check-conventions.mjs`). One is real: the payment ledger writes
`invoice.status` directly, because `INVOICE_TRANSITIONS` makes `PAID` terminal
and a returned payment has to roll it back (13 §6). Give the invoice machine a
reverse edge and that exception can go.

### Not here

The Playwright journey in plan 18 §5 is not implemented. It is marked optional
in the plan, needs both servers plus a browser download, and the integration
suite already covers the same chain over HTTP. The clock and job endpoints it
would need are in place, so it is additive when wanted.
