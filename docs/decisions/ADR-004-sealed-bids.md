# ADR-004 — Sealed bids with hash sealing and two enforcement layers

## Context

A sealed-bid tender's whole promise is that nobody — including the buyer who
owns the tender — can see any bid amount before the submission deadline. Honour
systems break on the first support ticket (*"my boss just needs to peek"*). The
leak surface is:

1. The ORM: a careless `include: { items: true }` on a buyer-side query.
2. The serializer: a field that should have been stripped was not.
3. A new endpoint written later that calls a service without the sealing
   context.

Any one of these leaks every amount. One defence is not enough.

## Decision

Two layers, both enforced:

1. **Service layer** holds a `canReadBidAmounts()` predicate that reads the
   actor and the tender state. Services take it as a parameter; the quotation
   list / detail / comparison endpoints all route through it.
2. **Serializer layer** owns the final cut. `toQuotationDto()` takes the same
   predicate and strips `subtotal`, `taxableAmount`, `taxAmount`,
   `grandTotal`, `freightAmount`, and all per-item prices if the predicate
   says no. If a service forgot to apply the predicate, the serializer still
   does.

A **submitted quotation is immutable**. At submit, the server computes a
`sealHash = sha256(canonical(payload))` and stores it. The receipt shown to the
vendor contains that hash. After the opening, anyone can recompute the hash
over the canonical payload and verify the bid is unchanged.

The sealing suite (`sealing.spec.ts`) walks every buyer-side quotation
endpoint and asserts zero bid-amount leaks pre-deadline. The plan 19 §5 review
greps the actual HTTP responses for known bid totals.

## Consequences

- Opening bids is an **explicit action**: `POST /tenders/:id/evaluation/open`,
  which flips `bidOpenedAt` and from then on every amount is visible. There is
  no accidental peek.
- The buyer can see the bidder count, who has bid, and the submission times
  before the deadline — none of which require an amount.
- Adding a new buyer-side endpoint means passing the predicate through. Missing
  it is caught by the sealing suite the moment the test is written.
- The hash is kept server-side. The receipt is for the vendor's record; nothing
  in the application relies on the vendor keeping it.
