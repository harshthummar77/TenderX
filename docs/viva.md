# Viva answers

Plan 20 §8. Eight questions an examiner is likely to ask, each with the shortest
honest answer and the screen or test to open if they want proof.

## 1. "Is this just CRUD?"

Sealed bidding, weighted evaluation, separation of duties, a three-way match,
TDS-aware payments, a hash-chained audit log, multi-tenant isolation enforced
at 404 (not 403). Each is a line in `docs/business-rules.md` with a test.

Then open the invoice verification screen on an exception and stop talking.

## 2. "How do you stop one company seeing another's data?"

Two layers:

- `middleware/authorize.ts` runs a permission check on every tenant-scoped
  route. Walk the matrix in `shared/src/permissions.ts`.
- Every service query goes through `scopeToOrg(actor)` or
  `scopeToVendor(actor)`. A row owned by another tenant is **absent** from the
  result set, so the response is 404, not 403 — no existence oracle.

Open `isolation.spec.ts` (21 tests). Then open `scope.ts`, delete one of the
`scopeTo…` calls in a service, re-run — six tests go red.

## 3. "What happens if two people click the same button at once?"

Three concurrency patterns, each tested:

- **Numbering**: `ON CONFLICT … RETURNING` on `number_sequences`. 20 parallel
  publishes produce `000001..000020` gaplessly (`publish.concurrency.spec.ts`).
- **Quantities**: `SELECT … FOR UPDATE` on the PO item inside the GRN
  transaction. 10 parallel GRNs never over-receive
  (`grn.concurrency.spec.ts`).
- **Payments**: `SELECT … FOR UPDATE` on the invoice inside `recordPayment`.
  10 parallel payments never over-pay the invoice
  (`payment.concurrency.spec.ts`).

## 4. "Why can't this invoice just be paid?"

Open the invoice on the match-exception demo tender. Walk the checklist on
screen: PO ✓, GRN ✓, price ✓, quantity ✗. Then trace the code path:

- `payment.service.recordPayment` calls `assertPayable(invoice)`.
- `assertPayable` reads `invoice.status === APPROVED_FOR_PAYMENT` and
  `invoice.matchStatus === MATCHED`.
- The match status is only `MATCHED` when every check in `match.engine.ts`
  passes.
- The quantity check reads `acceptedQuantity`, which is only written by a
  confirmed GRN inside `grn.service.recordGrn`.

The 50-character non-overridable-codes constant lives in
`shared/invoice/non-overridable-codes.ts` and is consumed by both the server
and the client, so the Override button is disabled for the same codes the
server rejects.

## 5. "How do you handle money precisely?"

`Decimal(18, 2)` in Postgres, `decimal.js` in services, **strings** over the
wire. Round at the end of each line, then sum. The GST test
(`tax.spec.ts`) covers CGST/SGST and IGST round-tripping; changing the split
divisor fails 9 tests with readable diffs.

See ADR-003.

## 6. "Could someone tamper with the history?"

Two defences, both demonstrable:

- **DB rules**: a migration adds `CREATE RULE … TO NOTHING` for UPDATE and
  DELETE on `activity_logs`. Through the application's own Postgres role, an
  `UPDATE activity_logs SET …` affects 0 rows. The ten-point security review
  runs this live.
- **Hash chain**: each row's hash depends on the previous row's. The
  `verifyAuditChain` function detects any insert, delete or edit. The
  `/api/v1/platform/activity/verify` endpoint runs the full-table check.

Open Neon's SQL editor against production, run `UPDATE activity_logs SET
summary='x'` → `UPDATE 0`. Then disable the rules in a scratch branch, edit a
row, and re-run `verifyAuditChain` — it names the first broken link.

## 7. "Why Neon and not a normal Postgres?"

- Branches per environment are a UI click; local Postgres would need three
  installs on Windows and a backup regime.
- Point-in-time restore is included on the free plan.
- No local install at all means `git clone && npm i` is the full dev setup.

The honest trade-off (ADR-005): autosuspend. The Neon compute sleeps after a
few minutes idle, which is why the scheduler runs every 15 minutes and tender
deadlines close lazily on read. A cold demo costs 30–40 seconds. The runbook
has the warm-up procedure.

## 8. "What would you build next?"

Each hangs off an existing table — name the table so it is clearly design, not
hand-waving:

- **E-invoicing / IRN integration** — a `government_invoice` column on
  `Invoice`, filled by an outgoing adapter after `APPROVED_FOR_PAYMENT`.
- **Split awards across vendors** — the `PurchaseOrder` already has
  `quotationId` nullable to allow this; a tender awards an item-vendor matrix.
- **Contract and rate-card management** — a `Contract` table that acts as the
  default price list for a direct PO (no tender).
- **Budget vs commitment control** — a `BudgetLine` table and a
  `BudgetAllocation` row written in the same transaction as PO issue.
- **Real payment rails** — swap the manual `recordPayment` for an adapter
  against NEFT / RTGS over host-to-host. The `Payment` row shape stays.

The sketched v2 is in `plans/_v2_enterprise/`. The point of naming the tables
is that each addition is additive, not a redesign.
