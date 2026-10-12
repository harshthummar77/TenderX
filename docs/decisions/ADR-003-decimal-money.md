# ADR-003 — Decimal money end to end, strings over the wire

## Context

JavaScript's `number` is IEEE 754 double. `0.1 + 0.2` is `0.30000000000000004`.
For GST, where line totals, tax, cess, discount and freight are added, rounded
and compared across many lines, a single floating-point sum is enough to make
an invoice fail its own match by one paisa. Defect C10 in the master plan.

Two separate problems:

1. The database must store money without rounding error.
2. The server must compute without picking up `number` on the way through.
3. The wire format must not re-introduce the error at the HTTP boundary.

## Decision

- **Database**: `Decimal(18, 2)` for every money column. 18 digits is enough for
  ₹99,99,99,99,99,99,99.99 and 2 decimals for paise.
- **Server**: `decimal.js` for every arithmetic path. Services take a Prisma
  `Decimal`, convert at the boundary with `.toString()` only. Round at the end
  of each line, then sum.
- **Wire**: money is a **string** in every DTO. Zod schemas accept strings and
  parse into `Decimal` server-side.
- **Client**: money stays a string. The `MoneyInput` component works in
  `BigInt` paise internally and renders with Indian lakhs/crores grouping.
  `lib/format.ts` is the only place that parses or formats money.

A conventions check (`npm run check:conventions`) greps the server for
`Number(…amount)` and `parseFloat(…price)` and fails the build. The three
genuine exceptions (payment.service, deadline.service, vendor.service) are
allow-listed with the reason inline.

## Consequences

- The invoice-match quantity and price checks hit the exact comparison every
  time. No `Math.abs(a - b) < 0.01` anywhere.
- Deserialising a DTO on the client is a strict operation: a number where a
  string was expected is a Zod validation error, not a silent cast.
- The GST test (`tax.spec.ts`) can assert integer paise and is the probe this
  session used to confirm nothing silently truncates: changing `div(200)` to
  `div(100)` for the CGST/SGST split failed 9 tests with readable diffs.
- Adding a new money column means updating the Prisma schema, the service,
  three Zod schemas and a serializer. The grep catches the fourth place.
