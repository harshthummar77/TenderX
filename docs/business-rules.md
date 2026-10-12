# Business rules

The 30 enforced rules that make this a procurement system and not a CRUD app
(plan 20 §3). Each row names the file that enforces the rule, the stable error
code the API returns when it fails, and a test that fails if the rule is
removed. Every test file listed exists under `server/test/` and currently
passes.

Grouped by lifecycle stage.

## Authentication and account

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 1 | Wrong password, unknown email and a locked account all return the same 401 body (no account-existence oracle) | `auth.service.ts` | `auth.invalid_credentials` | `auth.spec.ts` |
| 2 | Five failed attempts lock the account for 15 minutes | `auth.service.ts` | `auth.account_locked` (only on correct password) | `auth.spec.ts` |
| 3 | A reused refresh token revokes the entire family and audits as `SECURITY` | `token.service.ts` | `auth.refresh_reuse_detected` | `auth.spec.ts` |
| 4 | JWT access and refresh secrets must differ | `config/env.ts` | fatal boot error | `auth.spec.ts` (indirectly) |

## Permissions and tenancy

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 5 | A vendor token cannot reach any buyer-only endpoint | `middleware/authorize.ts` + route guards | `auth.forbidden` | `permissions.spec.ts` |
| 6 | A cross-tenant read of a resource that exists returns 404, not 403 | `lib/scope.ts` consumed in every service | — | `isolation.spec.ts` |
| 7 | `ORG_OFFICER` can never hold any of the separation-of-duties permissions | `shared/src/permissions.ts` | — (asserted by test) | `sod.spec.ts` |
| 8 | Every non-public route has `authenticate`; every tenant route has a `permissionGuard` | `permissions.spec.ts` walks the router | — | `permissions.spec.ts` |

## Vendor KYC

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 9 | GSTIN must pass the mod-36 checksum, and its first two digits must equal the vendor's state code | `shared/src/gstin.ts` + `vendor.service.ts` | `vendor.gstin_invalid`, `vendor.gstin_state_mismatch` | `gstin.spec.ts`, `vendor.spec.ts` |
| 10 | A duplicate GSTIN returns a 409 with a stable code, not a raw Prisma error | `vendor.service.ts` | `vendor.gstin_duplicate` | `vendor.spec.ts` |
| 11 | Bank details appear in no public DTO; the vendor sees only the last four digits | `vendor.serializers.ts` | — | `vendor.spec.ts` |
| 12 | A change to a bank field writes `[changed]` to the audit log, never the value | `vendor.service.ts` + `lib/audit.ts` | — | `vendor.spec.ts` |

## Sourcing

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 13 | A buyer cannot see a bid amount before the submission deadline | `quotation.serializers.ts` | `quotation.sealed` | `sealing.spec.ts` |
| 14 | Document numbers are gapless per fiscal year under concurrent writes | `lib/numbering.ts` (`ON CONFLICT … RETURNING`) | — | `publish.concurrency.spec.ts`, `numbering.spec.ts` |
| 15 | Parallel publishes of the same draft lock the row with `SELECT … FOR UPDATE` and only one succeeds | `tender.stateMachine.ts` | `tender.invalid_transition` | `publish.concurrency.spec.ts` |
| 16 | Only the invited vendor can submit a quotation to a tender | `quotation.service.ts` | `quotation.not_invited` | `quotation.spec.ts` |
| 17 | A submitted quotation is immutable (sealed hash recorded) | `quotation.service.ts` | `quotation.submitted` | `quotation.spec.ts`, `sealing.spec.ts` |
| 18 | A tender transition that is not on the state machine is a 422, not a 500 | `tender.stateMachine.ts` | `tender.invalid_transition` | `stateMachines.spec.ts`, `tender.spec.ts` |

## Evaluation

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 19 | The recommender cannot be the approver (separation of duties) | `approval.service.ts` | `approval.self_approval` | `sod.spec.ts` |
| 20 | Overriding an automated evaluation requires a justification of at least 50 characters | `evaluation.service.ts` | `evaluation.override_justification_required` | `evaluation.spec.ts` |
| 21 | A vendor with no history scores `null`, never zero | `scoring.ts` | — | `scoring.spec.ts` |

## Purchase orders

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 22 | Intra-state deals use CGST + SGST; inter-state uses IGST; nothing uses both | `lib/tax.ts` + `po.service.ts` | — | `tax.spec.ts`, `po.spec.ts` |
| 23 | A PO freezes the full party snapshot (GSTIN, address, state code) at issue | `po.service.ts` | — | `po.spec.ts` |
| 24 | Only one live (not-closed, not-cancelled) PO per quotation | partial unique index + service | `po.duplicate` | `po.spec.ts` |

## Fulfilment

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 25 | A delivery cannot ship more than the PO ordered | `delivery.service.ts` | `delivery.exceeds_ordered` | `grn.spec.ts` (via chain) |
| 26 | On a GRN, received = accepted + rejected per line (DB CHECK + service) | `grn.service.ts` + DB check | `grn.quantity_mismatch` | `grn.spec.ts`, `grn.concurrency.spec.ts` |
| 27 | A GRN uses `SELECT … FOR UPDATE` on the PO item to keep `receivedQuantity` consistent under concurrency | `grn.service.ts` | — | `grn.concurrency.spec.ts` |

## Invoicing and payment

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 28 | An invoice must pass all three-way match checks: PO exists, GRN confirms, price matches, quantity ≤ acceptedQuantity | `match.engine.ts` | match checks list in `invoice.matchResult` | `match.spec.ts` |
| 29 | A quantity exception on an invoice can never be overridden by anyone | `invoice.service.ts` + `shared/invoice/non-overridable-codes.ts` | `invoice.exception_not_overridable` | `invoice.spec.ts`, `match.spec.ts` |
| 30 | Two invoices with the same `vendorInvoiceNumber` from one vendor are a 409 (duplicate detection) | DB unique + `invoice.service.ts` | `invoice.duplicate` | `invoice.spec.ts` |
| 31 | A payment requires the invoice to be `APPROVED_FOR_PAYMENT` with `matchStatus = MATCHED` | `payable.ts` (`assertPayable`) | `invoice.not_payable` | `payable.spec.ts`, `payment.spec.ts` |
| 32 | TDS reduces net cash out, but settlement compares `amountPaid` to gross — so a TDS-deducted payment still closes the invoice | `payment.service.ts` | — | `payment.spec.ts` |
| 33 | Two concurrent payments against the same invoice are serialised with `SELECT … FOR UPDATE`; the invoice is never over-paid | `payment.service.ts` | — | `payment.concurrency.spec.ts` |
| 34 | Fully paying the final invoice on the last open PO closes the tender automatically | `cascade.ts` (close-on-last-paid) | — | `cascade.spec.ts` |

## Platform integrity

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 35 | `activity_logs` is append-only through the application: `UPDATE` affects 0 rows, `DELETE` affects 0 rows (two `CREATE RULE`s on the table) | migration + `audit.service.ts` | — | `audit.spec.ts` |
| 36 | Every audit row's hash depends on the previous row's hash; `verifyAuditChain` detects any insert, delete or edit | `lib/audit.ts` | returned `valid: false` | `audit.spec.ts` |
| 37 | Bank fields are redacted to `[redacted]` **before** being hashed, so the value is not recoverable from the chain either | `lib/audit.ts` | — | `audit.spec.ts`, `vendor.spec.ts` |
| 38 | Every service that writes also writes an `ActivityLog` row in the same transaction | per-service pattern | — | implicit across the suite |

## Documents

| # | Rule | Enforced in | Error code | Test |
|---|---|---|---|---|
| 39 | Magic bytes decide the file type; the extension and declared MIME are ignored | `document.service.ts` | `document.content_mismatch` | `document.spec.ts` |
| 40 | SVG and HTML files are rejected regardless of extension (can carry script) | `document.service.ts` | `document.type_not_allowed`, `document.content_mismatch` | `document.spec.ts` |

---

Every row here is in the test suite as of 2026-10-10. If a rule changes, update
the row and the test together: the test file is the primary source of truth,
this document is the index.
