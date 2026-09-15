# TenderBridge — Access control

Two layers, both provable by tests. Source of truth: `shared/src/permissions.ts`, imported by the
server *and* the client, so the matrix below cannot drift from what is enforced.

```text
Layer 1 — Route permission    requirePermission('tender:create')
          "may this ROLE do this ACTION at all?"        -> 403

Layer 2 — Data scoping        scopeToOrg(actor) in every service query
          "may this ACTOR see THIS ROW?"                -> 404 (never 403)
```

**Cross-tenant reads return 404, not 403.** A 403 confirms the row exists, which tells org A that
tender id X belongs to somebody. The 404 tells them nothing. It is a real security distinction and
it costs nothing.

The enterprise design had a third layer — a Prisma client extension injecting tenant filters
automatically. It was cut (`00 §3`). Here, scoping is a convention enforced by tests: the isolation
suite fails the moment a service forgets it.

---

## The two rules that carry this module

**Separation of duties.** `ORG_OFFICER` deliberately holds none of `approval:decide`,
`invoice:approve`, `invoice:override`, `payment:record`, `tender:cancel` or `po:issue`.

The officer runs the process — creates tenders, evaluates bids, recommends a winner, records goods
receipt. The admin authorises money — approves the award, approves the invoice, records the payment.
**One person can never take a purchase from tender to payment alone.** That sentence is the best
available answer to *"what makes this a business system rather than CRUD?"*

**The platform is not a tenant.** `PLATFORM_ADMIN` is read-only across tenants: it approves
organizations and vendors and reads audit logs, and holds no create or payment permission on any
tenant's data. A platform operator has no business issuing a customer's purchase order.

---

## Role matrix

| Permission | PLATFORM_ADMIN | ORG_ADMIN | ORG_OFFICER | VENDOR |
|---|:--:|:--:|:--:|:--:|
| **Platform** | | | | |
| `platform:manage` | **Y** | · | · | · |
| **Organization** | | | | |
| `organization:approve` | **Y** | · | · | · |
| `organization:view` | **Y** | **Y** | **Y** | · |
| `organization:update` | · | **Y** | · | · |
| `organization:member_manage` | · | **Y** | · | · |
| **Vendor** | | | | |
| `vendor:view` | **Y** | **Y** | **Y** | · |
| `vendor:create` | · | **Y** | **Y** | · |
| `vendor:update_self` | · | · | · | **Y** |
| `vendor:approve` | **Y** | · | · | · |
| `vendor:blacklist` | **Y** | · | · | · |
| **Tender** | | | | |
| `tender:view` | **Y** | **Y** | **Y** | **Y** |
| `tender:create` | · | **Y** | **Y** | · |
| `tender:update` | · | **Y** | **Y** | · |
| `tender:publish` | · | **Y** | **Y** | · |
| `tender:cancel` | · | **Y** | · | · |
| **Quotation** | | | | |
| `quotation:view_own` | · | · | · | **Y** |
| `quotation:submit` | · | · | · | **Y** |
| `quotation:view_all` | · | **Y** | **Y** | · |
| **Evaluation** | | | | |
| `evaluation:run` | · | **Y** | **Y** | · |
| `evaluation:recommend` | · | **Y** | **Y** | · |
| **Approval** | | | | |
| `approval:decide` | · | **Y** | · | · |
| **Purchase order** | | | | |
| `po:view` | · | **Y** | **Y** | **Y** |
| `po:issue` | · | **Y** | · | · |
| `po:respond` | · | · | · | **Y** |
| `po:cancel` | · | **Y** | · | · |
| **Delivery** | | | | |
| `delivery:create` | · | · | · | **Y** |
| **Goods receipt** | | | | |
| `grn:create` | · | **Y** | **Y** | · |
| **Invoice** | | | | |
| `invoice:submit` | · | · | · | **Y** |
| `invoice:view` | · | **Y** | **Y** | **Y** |
| `invoice:approve` | · | **Y** | · | · |
| `invoice:override` | · | **Y** | · | · |
| **Payment** | | | | |
| `payment:record` | · | **Y** | · | · |
| `payment:view` | · | **Y** | **Y** | **Y** |
| **Reports** | | | | |
| `report:view` | **Y** | **Y** | **Y** | · |
| **Audit** | | | | |
| `audit:view` | **Y** | **Y** | · | · |
| **Documents** | | | | |
| `document:upload` | · | **Y** | **Y** | **Y** |
| **Totals** | 9 | 26 | 16 | 11 |

The table is generated from `shared/src/permissions.ts`; a test asserts the two agree, so it cannot
go stale silently.

---

## Scoping helpers

`server/src/lib/scope.ts`:

| Helper | Filter | Used for |
|---|---|---|
| `scopeToOrg(actor)` | `{ organizationId }` | tenders, approvals, GRNs, number sequences |
| `scopeToVendor(actor)` | `{ vendorId }` | quotations, deliveries, vendor KYC |
| `scopeToParty(actor)` | org id *or* vendor id | documents both sides see: PO, invoice, payment |
| `findScoped(model, id, actor)` | fetch-or-404, scoped | **the default way to load any row by id** |
| `assertOwned(actor, row)` | throws 404 | a row already loaded by other means |

The rule, stated once so it is never argued about again: a service that reads or writes a
tenant-owned row uses `findScoped`, or spreads a `scopeTo*()` into its `where`. There is no third
option. Rows reached through a parent (`QuotationItem`, `GrnItem`, `InvoiceItem`) are scoped by
loading the parent first — never fetch a child by id alone.

`PLATFORM_ADMIN` short-circuits every helper to `{}` — it reads across tenants by design, and holds
no write permission to abuse it with.

---

## Route shape

Every route carries an auth guard and a permission guard, in this order:

```ts
router.post('/tenders',
  authenticate,
  requireActiveOrg,                    // plan 05
  requirePermission(P.TENDER_CREATE),
  validate({ body: createTenderSchema }),
  tenderController.create);
```

A route-coverage test walks the Express stack and fails if any non-public route is missing either
guard, so this cannot be forgotten quietly. The public allow-list is short and explicit: health,
registration, login, refresh, password reset, and the two invitation-token routes the invitee reaches
before they have an account.

`requireAnyPermission()` exists for the one endpoint several roles reach for different reasons:
invitations. An org admin manages members, a vendor manages its own company's logins, a platform
admin manages the platform. Which role each may actually *grant* is then decided by the role-grant
matrix in the invitation service — and an `ORG_OFFICER`, holding none of the three, never gets past
layer 1.

---

## On the client

`client/src/lib/permissions.ts` re-exports the same shared file. The UI hides what the user cannot do:

```tsx
const { can } = useAuth();
{can(P.PAYMENT_RECORD) && <Button onClick={recordPayment}>Record payment</Button>}
```

The hidden button is **convenience, not security**. The server answers 403 whether or not the UI drew
it; plan 18 calls each hidden action directly with an officer's token to prove it.
