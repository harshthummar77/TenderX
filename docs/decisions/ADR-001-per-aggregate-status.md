# ADR-001 — Per-aggregate status fields, not one global workflow

## Context

An early sketch had one `WorkflowStatus` on the tender that walked `DRAFT →
PUBLISHED → BIDDING_CLOSED → UNDER_EVALUATION → AWARDED → PO_ISSUED →
GOODS_RECEIVED → INVOICED → PAID`. That looked clean on a diagram and was
defect C2 in the master plan.

The reality is that a tender has many POs (partial awards, split delivery, PO
amend-and-reissue), a PO has many deliveries and GRNs, an invoice can be
rejected and resubmitted independently of its PO, and a payment can be partial
and reconciled after the fact. A single status field cannot represent any of
that without lying about one aggregate to accommodate another.

## Decision

Each aggregate owns its own enum:

- `TenderStatus` is **sourcing only**: `DRAFT → PUBLISHED → BIDDING_CLOSED →
  UNDER_EVALUATION → PENDING_APPROVAL → AWARDED → CLOSED` (or `CANCELLED`).
- `PoStatus` is the contract state: `DRAFT → ISSUED → ACCEPTED → CLOSED`.
- `FulfilmentStatus` on the PO is **derived** from its lines' received /
  accepted / invoiced quantities.
- `InvoiceStatus`, `MatchStatus`, `PaymentStatus` each own their own path.

Transitions are gated by per-module state machine files (`*.stateMachine.ts`)
with illegal moves raising a `*.invalid_transition` 422, not throwing.

## Consequences

- The screens read naturally: a tender *can be* AWARDED while its PO is
  partially fulfilled and its invoice is still under match. No field is lying.
- The join query the aggregate dashboard runs is slightly larger (one count per
  aggregate), which is why `GET /dashboard` runs its reads in parallel.
- Writing a new feature requires choosing which enum changes. That is a feature,
  not a cost: if the choice is not obvious, the model is probably wrong.
- Three independent state machines means three independent test files. The
  state-machine tests are table-driven over the transition map and run in <100 ms.
