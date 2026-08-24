# TenderBridge — Architecture

Source of record for the decisions locked in `plans/00_MASTER_PLAN.md`.
If code and this document disagree, one of them is a bug — fix both in the same commit.

---

## 1. What the system is

TenderBridge is a **multi-tenant source-to-pay procurement platform**.

Buyer organizations publish itemised tenders (RFQs) to a pre-qualified vendor network. Vendors submit **sealed** quotations that stay hidden from the buyer until the bid deadline passes. A scoring engine ranks bids on price, delivery and vendor performance. An approval step (with separation of duties) awards the tender and auto-generates a **GST-compliant purchase order**. Fulfilment is tracked through partial deliveries and goods-received notes. Vendors raise invoices, which the system clears only after an automated **three-way match** between PO, GRN and invoice. Payments record TDS and retention, settle the invoice, and cascade-close the PO and tender. Every state change lands in an **append-only, hash-chained audit log**.

### Actors

| Role | Party | Owns |
|---|---|---|
| `PLATFORM_ADMIN` | platform | organization approval, vendor approval, platform-wide reporting |
| `ORG_ADMIN` | buyer organization | org profile, officers, settings, approval of awards above threshold |
| `ORG_OFFICER` | buyer organization | tenders, evaluation, GRN, invoice verification, payment recording |
| `VENDOR` | vendor company | vendor profile + KYC, quotations, dispatch, invoices |

A user belongs to exactly one party: `User.role` plus `User.organizationId?` **or** `User.vendorId?`.

---

## 2. Runtime architecture

```text
                     ┌─────────────────────────────────┐
 Browser (React SPA) │  Express 5 API   /api/v1        │
 Vercel              │  (Render, single instance)      │
                     └───────────────┬─────────────────┘
                                     │
   ┌─────────────────┬───────────────┼───────────────┬─────────────────┐
   │                 │               │               │                 │
 routes/         middleware/     services/       lib/              jobs/
 (Express)       auth, rbac,     business        tax engine        node-cron
 controllers     validate,       rules +         match engine      (every 15 min)
 (< 20 lines)    errors          transactions    scoring engine
                                     │           numbering, audit, pdf
                                     ▼
                     ┌─────────────────────────────────┐
                     │  Prisma 6  →  Neon Postgres     │
                     └─────────────────────────────────┘
                          Cloudinary (files)   SMTP (mail)
```

**Layering rule, enforced by code review:** `route → controller → service → prisma`.
Controllers never touch Prisma. Services never touch `req` / `res`.

### The five engines

Being wrong in these costs money, so they are pure functions with exhaustive unit tests and no I/O.

| Engine | Lives in | Responsibility |
|---|---|---|
| Tax | `server/src/lib/tax/` | HSN/SAC per line, place-of-supply, CGST+SGST vs IGST, per-line rounding, round-off |
| Scoring | `server/src/lib/scoring/` | weighted criteria, min–max normalisation, ranking |
| Three-way match | `server/src/lib/match/` | PO ↔ GRN ↔ invoice quantity and price reconciliation, exception codes |
| Numbering | `server/src/lib/numbering/` | atomic, gapless, fiscal-year-scoped document numbers |
| Audit | `server/src/lib/audit/` | SHA-256 hash chain over `ActivityLog` |

---

## 3. Domain model spine

Everything is itemised end to end. This chain is the reason the project is not CRUD:

```text
TenderItem → QuotationItem → PurchaseOrderItem → DeliveryItem → GrnItem → InvoiceItem
```

Aggregate flow:

```text
Tender ──award──▶ PurchaseOrder ──dispatch──▶ Delivery ──receive──▶ Grn
   ▲                    │                                            │
   │                    └──────────────── three-way match ───────────┤
   │                                                                 ▼
   └──────────── cascade close ◀── Payment ◀── settle ◀──────────  Invoice
```

Cardinality that the original spec got wrong: **one PO has many deliveries, many GRNs, many invoices, and many payments.** All downstream relations are one-to-many with cumulative quantity reconciliation.

---

## 4. Corrections applied to the original specification

These corrections are the engineering content of the project.

| # | Problem in original spec | Why it breaks | Correction applied |
|---|---|---|---|
| C1 | Tender has one `quantity` + one `budget` field | Real RFQs have many line items with different units, HSN codes, tax rates. Bid comparison is meaningless without per-item pricing. | Line-item chain: `TenderItem → QuotationItem → PurchaseOrderItem → DeliveryItem → GrnItem → InvoiceItem`. Everything is itemised end to end. |
| C2 | One status enum mixes tender, PO, invoice and payment states | One column cannot be the truth for four aggregates. Produces impossible states like `PAYMENT_COMPLETED` on a rejected PO. | Each aggregate owns its own status enum and its own state machine. Downstream progress is **derived**, never stored twice. |
| C3 | Organization generates the invoice from the PO | In real accounts payable the **vendor raises the invoice** and the buyer verifies it. Buyer-generated invoices destroy the entire control story. | Vendor submits an invoice against a PO + GRN. Buyer runs a **three-way match**. |
| C4 | GST fields present but no tax model | One `taxAmount` column cannot produce a legal Indian invoice. | Full GST engine: HSN/SAC per line, place-of-supply logic, CGST+SGST (intra-state) vs IGST (inter-state), per-line rounding, round-off. |
| C5 | Quotations visible to the officer as they arrive | Destroys tender integrity — an officer can leak competitor pricing. | **Sealed bidding.** Bid amounts are unreadable by the buyer until the deadline. Submissions are SHA-256 hash-sealed and timestamped. |
| C6 | Approval is a single boolean-ish step | Real orgs approve by value and cannot let the requester approve their own request. | `Approval` record + value threshold + **separation of duties**: the person who recommends can never be the person who approves. |
| C7 | One PO → one delivery → one invoice → one payment | Real procurement has partial deliveries, multiple invoices per PO, and part payments with TDS/retention. | All downstream relations are one-to-many with cumulative quantity reconciliation. |
| C8 | No concurrency control | Two officers clicking "Generate PO" creates two POs. Two GRNs on one line over-receive. | Atomic `INSERT … ON CONFLICT DO UPDATE RETURNING` numbering, `SELECT … FOR UPDATE` row locks on quantity reconciliation, partial unique indexes. |
| C9 | Audit log is a plain editable table | A tamper-able audit table proves nothing. | Append-only `ActivityLog` with `CREATE RULE` blocking UPDATE/DELETE, plus a SHA-256 hash chain and a verify endpoint. |
| C10 | Money type unspecified (implies float) | Float arithmetic on money is a defect, always. | `Decimal(18,2)` in Postgres, `decimal.js` in services, **string** over the wire. Never a JS `number`. |
| C11 | Files via Multer to local disk | Local disk is wiped on every Render redeploy. KYC documents vanish mid-demo. | Cloudinary private storage + `Document` registry table + signed, expiring download URLs. |
| C12 | Email sent inline inside request handlers | A dead SMTP server takes down tender publishing. | Notification row written **in the same transaction**; email fired best-effort and never awaited on the critical path. |
| C13 | Role checks scattered as `if (role === 'ADMIN')` | Unmaintainable; guarantees an authorization bug. | Central `PERMISSIONS` map + `requirePermission()` middleware + `scopeToOrg()` data helper + an isolation test suite. |
| C14 | Vendor tied 1:1 to a user account | Cannot model a vendor company with two staff logins. | `User` carries `role` + `organizationId?` / `vendorId?`. Many users per party. |
| C15 | PO / invoice numbers "auto-generated" | `count() + 1` breaks under concurrency and is not fiscal-year scoped. | `NumberSequence` table, atomic upsert, format `PO/2025-26/000042`. |
| C16 | No evaluation methodology | "Lowest price" is not procurement. | Weighted scoring: configurable criteria per tender, min–max normalisation, auto-ranking, documented recommendation with justification. |

**Kept from the original specification, because they are correct:** the four-actor model, merging Manager into Org Admin, the *"payment only after delivery confirmation"* rule (encoded once as `assertPayable()`), and manual payment recording instead of a payment gateway.

---

## 5. Scope decisions

"I didn't have time" is not an answer. Each row below is a deliberate trade-off.

### 5.1 Simplified from the enterprise design

| Enterprise approach | What we build | Trade-off accepted |
|---|---|---|
| `Membership` table (user × tenant × role) | `User.role` + `User.organizationId?` + `User.vendorId?` | A user belongs to exactly one party. Cannot model a consultant serving two buyers. Saves a join on every authenticated request. |
| 6 roles + per-member permission overrides | 4 roles: `PLATFORM_ADMIN`, `ORG_ADMIN`, `ORG_OFFICER`, `VENDOR` | No custom permission grants. Matches the four-actor model exactly. |
| Policy engine + Prisma tenant extension + route-coverage test | `requirePermission()` middleware + `scopeToOrg()` helper + isolation test suite | Two layers of defence instead of three. Tenant scoping is a convention enforced by tests, not by the ORM. |
| `ApprovalRule` table with amount bands and multi-level chains | Single-level approval + one `approvalThresholdAmount` in org settings | No delegation-of-authority routing. Separation of duties — the part that matters — is preserved. |
| Transactional outbox + `pg-boss` worker + retry/backoff/DEAD | `Notification` row in-transaction + best-effort email + a 15-minute `node-cron` sweeper | An email can be lost if SMTP is down at that instant. The in-app notification never is. |
| Presigned S3 upload (presign → PUT → confirm) | `multer` memory → Cloudinary `upload_stream` → signed download URL | File bytes pass through the API. Fine at our file sizes; would not scale to 100 MB uploads. |
| `PaymentAllocation` join table (one payment → many invoices) | `Payment.invoiceId` (many payments → one invoice) | Cannot pay five invoices with one bank transfer. Partial payment, TDS and retention still fully demonstrated. |
| RFC 9457 `application/problem+json` | `{ success, data, meta }` / `{ success: false, error: { code, message, fields } }` | Not an IETF standard envelope. Much easier to consume from React. |
| Cursor pagination | `?page=1&limit=20` offset pagination | `OFFSET` degrades on very large tables. Our largest table is the audit log, and it is filtered by entity. |
| Testcontainers | A dedicated Neon `test` branch, truncated between test files | Tests need network. In exchange, **no Docker is required anywhere in this project**. |
| `zod-to-openapi` + Swagger UI | `docs/api.md` generated by a script that walks the Express router | No interactive "try it" console. No `.openapi()` boilerplate on 60 schemas either. |
| citext + pg_trgm extensions | Lowercase emails at write time + Prisma `mode: 'insensitive'` | Search is `ILIKE`, not trigram-ranked. Two fewer raw-SQL migrations to break. |
| ~15 raw-SQL CHECK constraints | 4 critical DB constraints; the rest enforced in the service layer with tests | Slightly weaker defence in depth, much smaller migration surface. |
| ~380 tests with coverage gates and custom ESLint rules | ~80 targeted tests, no gates | Coverage percentage is not a goal. The five engines where being wrong costs money are tested exhaustively. |

### 5.2 Cut entirely — scope decisions, not omissions

Docker / docker-compose / MinIO / Mailpit (Neon + Cloudinary replace all local infra) · `pg-boss` · `Idempotency-Key` headers · optimistic locking `version` columns · soft-delete Prisma extension · AES-256-GCM encryption at rest · MFA/TOTP · SSE live notifications (refetch on window focus instead) · command palette · PO amendments and versioning · payment reversal · split awards · nested category trees · XLSX export (CSV only) · GST summary and cycle-time reports · daily digest email · gitleaks / Dependabot / auto-deploy workflow · `pg_dump` backup job (Neon PITR replaces it) · GDPR data-export endpoint · common-password blocklist · a full Playwright suite (one optional happy-path spec instead).

Each of these is specified in `plans/_v2_enterprise/`, which doubles as the **Future Scope** chapter.

---

## 6. Tech stack

### Server

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript (ESM) | 25 models — types pay for themselves in week 2 |
| Framework | Express 5 | Native async error propagation: no `asyncHandler` wrappers anywhere |
| ORM | Prisma 6 (multi-file schema) | Generated types are the reason to use TypeScript |
| Database | Neon Postgres | Serverless, branchable, no local install |
| Validation | Zod (shared with the client) | One schema, two consumers |
| Auth | JWT access 15 min (memory) + rotating refresh token in an httpOnly cookie | No token in `localStorage` |
| Hashing | `bcryptjs` cost 12 | Pure JS — zero native build risk on Windows. `argon2` is the documented upgrade |
| Files | `multer` (memory) + `cloudinary` (private) | No AWS SDK, no CORS config, free tier |
| Mail | `nodemailer` (Gmail app password) + console fallback | Mail never blocks a request or a demo |
| PDF | `@react-pdf/renderer` | Deterministic, no headless Chrome in a 512 MB instance |
| Jobs | `node-cron`, 15-minute tick | Polling frequency is a Neon cost decision — see §8 |
| Logging | `pino` + `pino-http` with a request id | Structured, greppable |
| Money | `decimal.js` | Never a float |
| Testing | `vitest` + `supertest` against a Neon `test` branch | Real Postgres, no Docker |

### Client

| Concern | Choice |
|---|---|
| Build | Vite 6 + React 19 + TypeScript |
| Routing | React Router 7 (nested layouts) |
| Server state | TanStack Query 5 — **all** API access |
| Client state | Zustand — auth only, keep it tiny |
| Forms | React Hook Form + `@hookform/resolvers/zod` |
| UI | Tailwind CSS 4 + shadcn/ui |
| Tables | TanStack Table 8 |
| Charts | Recharts |
| Dates | `date-fns` |

### Infrastructure (all free tier)

Neon (database) · Render (API) · Vercel (client) · Cloudinary (files) · Gmail SMTP (mail).

---

## 7. Cross-cutting conventions

Not negotiable per file.

**IDs** — `String @id @default(uuid(7)) @db.Uuid`. Prisma 6 generates UUIDv7 natively: time-sortable, index-friendly, non-enumerable.

**Money** — `Decimal @db.Decimal(18, 2)` in Postgres, `decimal.js` in services, **string** in JSON:

```jsonc
{ "totalAmount": "125000.00" }   // never 125000 as a number
```

**Quantities** — `Decimal @db.Decimal(18, 3)` (supports 0.5 kg, 2.25 m).

**Timestamps** — `DateTime @db.Timestamptz(3)`, always UTC. API emits ISO-8601. Display timezone is a client concern.

**Response envelope**

```jsonc
// success
{ "success": true, "data": { }, "meta": { "page": 1, "limit": 20, "total": 128, "pages": 7 } }

// failure
{ "success": false,
  "error": {
    "code": "invoice.match_exception",
    "message": "Invoice has unresolved match exceptions",
    "fields": [{ "path": "items.0.quantity", "message": "must be > 0" }]
  },
  "requestId": "01J8..." }
```

Every error carries a **stable `code`**. Codes are the join key between `docs/business-rules.md`, the test names and the UI's error messages.

**Pagination** — `?page=1&limit=20&sort=-createdAt`. Default limit 20, max 100.

**Naming** — DB tables `snake_case` plural via `@@map`; Prisma models `PascalCase` singular; API paths `kebab-case` plural; JSON fields `camelCase`.

**Two invariants that must never be broken**

1. A status field is only ever written by that aggregate's state machine — never a raw `prisma.x.update({ data: { status } })` from a service.
2. Every state change writes an `ActivityLog` row **inside the same transaction** as the change.

---

## 8. Neon operating notes

**A. Pooled vs direct connection.** Prisma needs both:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")   // pooled:  ep-xxx-pooler.<region>.aws.neon.tech
  directUrl = env("DIRECT_URL")     // direct:  ep-xxx.<region>.aws.neon.tech
}
```

`directUrl` is used by `prisma migrate`, `db push`, `db seed` and `studio`. Using the pooled URL for migrations is the most common Neon + Prisma failure and produces confusing prepared-statement errors.

**B. Autosuspend and the compute allowance.** The Neon free plan suspends the compute after a few minutes of inactivity and caps monthly compute-hours. A job that queries the database every minute keeps the compute awake 24/7 and burns the entire allowance. Therefore:

- The `node-cron` sweeper runs **every 15 minutes**, never every minute.
- Deadline handling is **lazy-close-on-read**: when anyone lists tenders, any `PUBLISHED` tender past its deadline is closed inside that same request. Cron is only the safety net for tenders nobody looks at.
- Email is sent inline and fire-and-forget. There is no polling worker.
- Before a live demo, hit `/api/v1/health` a minute early — Render's free instance sleeps too.

**C. Branching replaces local Postgres.**

| Neon branch | Used by | Notes |
|---|---|---|
| `main` | deployed API on Render | production data, seeded |
| `dev` | `npm run dev` on your laptop | branch off `main`, reset freely |
| `test` | `npm test` | truncated between test files |

**What still works on Neon:** `CREATE RULE` for the append-only audit table, `BIGSERIAL`, CHECK constraints, `SELECT ... FOR UPDATE` row locks, `prisma migrate deploy`.

**Backups:** Neon point-in-time restore. No `pg_dump` job. Restore procedure is documented in `docs/runbook.md`.

---

## 9. Repository layout

```text
tenderbridge/
├── server/           # Express + Prisma           (npm workspace)
├── client/           # Vite + React               (npm workspace)
├── shared/           # Zod schemas, enums, types  (npm workspace, tsc → dist)
├── docs/
├── plans/
│   └── _v2_enterprise/   # archived enterprise plan set = Future Scope
└── package.json      # npm workspaces + root scripts
```

Package manager: **npm**.

---

## 10. Definition of Done (every module)

1. Prisma models + a named migration are committed.
2. Zod schemas live in `shared/` and are imported by **both** apps.
3. Business rules are in the service layer; the controller is under 20 lines.
4. Every route has an auth guard and a permission check.
5. State changes go through the state machine and write an `ActivityLog` row in the same transaction.
6. Tests: the module's business rules (unit) + one integration test per endpoint covering happy path, one permission denial, and one validation failure.

---

## 11. Build order

```text
01 Setup & Neon
 └─ 02 Database Schema
     ├─ 03 Auth
     │   └─ 04 RBAC & Tenancy ─────────────┐
     │       ├─ 05 Organization            │  every module
     │       └─ 06 Vendor                  │  from 05 onward
     │           └─ 07 Tender              │  depends on 04
     │               └─ 08 Quotation (sealed)
     │                   └─ 09 Evaluation, Approval & Award
     │                       └─ 10 Purchase Order + GST
     │                           └─ 11 Delivery & GRN
     │                               └─ 12 Invoice & Three-Way Match
     │                                   └─ 13 Payment
     └─ 14 Files, Notifications & Audit   (needed from 06 onward)

15 Reports & Dashboards   → after 13
16 Frontend Foundation    → can start right after 03
17 Frontend Screens       → tracks backend modules 05–15
18 Testing                → continuous; formalised here
19 Deployment             → after 01, finalised at the end
20 Seed, Demo & Docs      → last
```

Plan files live in `plans/`, executed in numeric order. If reality contradicts a plan once code exists, edit the plan file in the same commit.
