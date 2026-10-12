# Architecture Decision Records

Six short records of the decisions that shaped this system (plan 20 §5). Each
follows context → decision → consequences and takes about a minute to read.
These are the questions a reviewer or a viva examiner is most likely to ask.

| # | Title |
|---|---|
| [001](ADR-001-per-aggregate-status.md) | Per-aggregate status fields, not one global workflow |
| [002](ADR-002-vendor-raised-invoices.md) | Vendor-raised invoices with a three-way match |
| [003](ADR-003-decimal-money.md) | Decimal money end to end, strings over the wire |
| [004](ADR-004-sealed-bids.md) | Sealed bids with hash sealing and two enforcement layers |
| [005](ADR-005-neon-serverless.md) | Neon serverless Postgres: branches, pooled vs direct, autosuspend |
| [006](ADR-006-scope-reductions.md) | Deliberate scope reductions (no outbox, no Docker, no at-rest encryption) |
