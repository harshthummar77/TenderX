# Cut list

Plan 20 §6. The order in which to cut if the deadline is slipping.

## Safe to cut (in this order)

Each of these leaves the demo intact.

1. **Dark mode.**
2. **CSV export** — show the table.
3. **Spend and tender report pages** — the dashboards cover the headline figures.
4. **Playwright** — the integration suite already drives the full chain over
   HTTP (`cascade.spec.ts`, `payment.spec.ts`).
5. **Payment advice PDF.**
6. **Invoice PDF** — keep the PO PDF.
7. **Vendor suggestion ranking** — show the plain directory instead.
8. **Short-close** (closing a PO with less than ordered).
9. **Direct POs without a tender** — covered by the audit log table shape, but
   the UI path can be dropped.
10. **PO amend-and-reissue.**
11. **Email retry job** — the first attempt still happens inline.
12. **Notification preferences** — ship with the matrix hard-coded.
13. **Scorecard breakdown pop-over** — keep the numeric rating.
14. **Mobile layout for buyer screens** — vendor screens must stay mobile-first.

## Never cut

These are the project. Dropping any of them makes the result a different
project with the same name.

- Authentication and RBAC.
- Tenant isolation (`scopeToOrg`, `scopeToVendor`, 404-not-403).
- Line-item modelling (quantity, taxable value, tax amount, line total).
- Sealed bidding with the hash and the two enforcement layers.
- The scoring engine (weighted score, deviations, null-rating path).
- Approval with separation of duties.
- PO with the GST engine (CGST/SGST vs IGST, place of supply).
- GRN with partial quantities.
- **The three-way match**, including the non-overridable quantity exception.
- Payment with `assertPayable()` and the auto-close cascade.
- The hash-chained audit log.
- One dashboard per role.
- The demo seed.

If any of the "never cut" list is going badly, cut from the "safe to cut" list
to get back time. If one of them is genuinely at risk, the honest answer is a
smaller scope statement in the report, not a half-built version in code.
