# ADR-002 — Vendor-raised invoices with a three-way match

## Context

A buyer-generated invoice is simpler to model: the buyer knows what was ordered
and what was accepted, so it can print its own invoice and the vendor just gets
paid. That is also exactly how it works nowhere in Indian procurement. The
vendor raises the invoice; the buyer pays it. The buyer's job is to verify.

Defect C3 in the master plan was proposing the easier model and realising
late that it does not match the domain.

## Decision

Vendors raise invoices against POs they have accepted. The invoice carries the
vendor's own invoice number (`vendorInvoiceNumber`), which is unique per vendor
and is the key the duplicate-invoice detection uses. The buyer runs a
**three-way match** against the PO and the GRNs:

1. **PO exists and is live.** Not cancelled, not closed, invoice references a
   PO item the vendor owns.
2. **GRN confirms the quantity.** Invoiced quantity ≤ accepted quantity across
   all GRNs for the PO. A quantity exception is **non-overridable** — nobody can
   mark it passed.
3. **Price matches.** The unit price on the invoice equals the unit price on
   the PO item. A price exception can be overridden with a justification of at
   least 50 characters.

The result is stored as JSON in `invoice.matchResult`, so the match checklist
screen can walk the exact structure the engine wrote.

## Consequences

- The invoice becomes `MATCHED` only after a confirmed GRN, which is why
  settlement needs the match status set, which is why `assertPayable()` reads
  `matchStatus` not `status`.
- A duplicate `vendorInvoiceNumber` from the same vendor is a 409 with a stable
  code, not a raw Prisma uniqueness error.
- The non-overridable rule is enforced in the shared `NON_OVERRIDABLE_CODES`
  set, re-used by the client to grey out the Override button so the user never
  sees a control that will 422.
- Fully paying the last matched invoice on the last open PO closes the tender
  — a cascade written in `cascade.ts`. Nothing in the UI closes a tender
  explicitly; the money closes it.
