# ADR-006 — Deliberate scope reductions

## Context

The temptation on a solo project with a hard deadline is to add features and
patterns because they appear in enterprise systems and would look impressive.
A thing added badly is worse than a thing not added at all. This record names
the pieces that were cut on purpose and what each would cost.

## Decision

The things not in the system, and why:

| Not here | Why cut | What it would look like |
|---|---|---|
| **Outbox / transactional events** | One instance, one database, every state change is in the same transaction as its audit row. The outbox pattern solves distributed-write consistency that this project does not have. | A per-event `outbox` table written in the same tx, a worker consuming it. The real cost is dedupe on the consumer side. |
| **Docker, docker-compose** | Neon replaces local Postgres; the stack is `npm install` and a `.env`. A `Dockerfile` would exist to be read in the viva, not run. | Multi-stage node:22-alpine build, mount `/app/node_modules`, non-root user. |
| **At-rest encryption of bank fields** | Neon encrypts the volume. Application-level encryption needs a KMS this project cannot host for free, and the field-level DTOs already keep the value out of every public response. | AES-256-GCM with a key per org from Vault/KMS, encrypted column + a decryption helper used only on the vendor's own detail page. |
| **MFA** | One user population, no admin console on the internet beyond the app itself. The first thing I would add if this were real. | TOTP via `otplib`, a recovery-code table, a second-factor prompt on login. |
| **`PaymentAllocation` across invoices** | Within scope: one payment, one invoice. A single payment that settles several invoices (common in retention + progress billing) was not needed to prove the three-way match. | Join table `(paymentId, invoiceId, grossApplied)`; `assertPayable` would walk it instead of the direct FK. |
| **gitleaks in CI** | `.env` is ignored from commit zero, there is one developer, and the rotation procedure in the runbook is the control that actually matters when a secret leaks. | A `gitleaks` step before `test:unit`, failing the build on any match. |
| **SSRF allow-list** | No user-supplied URL is ever fetched server-side. This is a design property, not an omission. | Allow-list of hosts the server may call, enforced in a wrapper around `fetch`. |
| **Redis-backed rate limiting** | One instance. Two would need a shared store, and that is a scaling decision, not a security one. | `express-rate-limit` with the Redis store, Upstash on the free tier. |
| **Playwright / E2E suite** | The integration suite already drives the full source-to-pay chain over HTTP, and the ten-minute demo script tests the same path by hand. Playwright would run against a built client in CI and would double the test wall time. | A `playwright.config.ts` + `source-to-pay.spec.ts` recorded as a video. |

The full v2 shape of each is sketched in `plans/_v2_enterprise/`.

## Consequences

- Every "missing" feature here has a named reason, not silence. In a viva, the
  honest answer "I did not build an outbox because I have one database and no
  distributed writes" beats a half-built one that cannot defend itself.
- The code reads as *intended for its own scope* rather than as a cut-down
  version of something larger. There is no half-finished `OutboxEvent` table
  nobody writes to.
- If any of these turn out to be wrong, each is a self-contained addition. The
  table above is also the pre-written design doc for whoever picks the project
  up next.
