-- Constraints the ORM cannot express (plan 02 §8).
-- Hand-written: Prisma does not generate CHECK constraints, partial unique
-- indexes or rules from the schema, so this migration is the source of truth
-- for all three. Standard Postgres — everything here works unchanged on Neon.
--
-- NOTE: table names are snake_case (via @@map) but COLUMN names are camelCase,
-- because the models carry no per-field @map. Every column below is therefore
-- double-quoted; unquoted identifiers would be folded to lower case and fail
-- with 42703.

-- A user belongs to at most one party. Platform admins belong to neither.
ALTER TABLE users ADD CONSTRAINT user_single_party
  CHECK (num_nonnulls("organizationId", "vendorId") <= 1);

-- Goods receipt must reconcile exactly.
ALTER TABLE grn_items ADD CONSTRAINT grn_quantity_reconciles
  CHECK ("acceptedQuantity" + "rejectedQuantity" = "receivedQuantity");

-- Never pay more than the invoice.
ALTER TABLE invoices ADD CONSTRAINT invoice_not_overpaid
  CHECK ("amountPaid" <= "totalAmount");

-- Positive money and quantities where it matters.
ALTER TABLE purchase_order_items ADD CONSTRAINT po_item_positive
  CHECK ("quantity" > 0 AND "unitPrice" >= 0);

-- One live PO per awarded quotation (a cancelled PO frees the quotation for re-award).
CREATE UNIQUE INDEX one_active_po_per_quotation
  ON purchase_orders ("quotationId")
  WHERE status <> 'CANCELLED' AND "quotationId" IS NOT NULL;

-- Exactly one current quotation revision per vendor per tender.
CREATE UNIQUE INDEX one_latest_quotation
  ON quotations ("tenderId", "vendorId")
  WHERE "isLatest" = true;

-- One open approval per entity — blocks double-submission races.
CREATE UNIQUE INDEX one_pending_approval
  ON approvals ("entityType", "entityId")
  WHERE status = 'PENDING';

-- The audit log is append-only. The application cannot rewrite history.
CREATE RULE activity_logs_no_update AS ON UPDATE TO activity_logs DO INSTEAD NOTHING;
CREATE RULE activity_logs_no_delete AS ON DELETE TO activity_logs DO INSTEAD NOTHING;
