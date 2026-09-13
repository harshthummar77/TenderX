# TenderBridge — ER diagrams

Two views, both generated from `server/prisma/schema/*.prisma`:

| File | What it shows | Use it for |
|---|---|---|
| `er-diagram.mmd` | all 25 entities, 44 foreign keys | the full schema figure |
| `er-chain.mmd` | the six-hop item chain with its key columns | the figure people can actually read |

A `.mmd` file holds exactly one diagram — paste one file at a time into <https://mermaid.live> and
export the PNG (`er-diagram.png`, `er-chain.png`).

Generated from `server/prisma/schema/*.prisma`. Mermaid renders inline on GitHub and in VS Code;
export a PNG for the report with the Mermaid Live Editor (<https://mermaid.live>) or the
Markdown Preview Mermaid extension, and save it next to this file as `er-diagram.png`.

The six-hop item chain is the spine to trace: **TenderItem → QuotationItem → PurchaseOrderItem →
DeliveryItem → GrnItem → InvoiceItem**.

```mermaid
erDiagram
  Organization |o--o{ User : "organization"
  Vendor |o--o{ User : "vendor"
  User ||--o{ RefreshToken : "user"
  User ||--o{ Invitation : "invitedBy"
  Organization ||--o{ Tender : "organization"
  Category |o--o{ Tender : "category"
  Tender ||--o{ TenderItem : "tender"
  Tender ||--o{ TenderInvitation : "tender"
  Vendor ||--o{ TenderInvitation : "vendor"
  Tender ||--o{ Quotation : "tender"
  Vendor ||--o{ Quotation : "vendor"
  Quotation ||--o{ QuotationItem : "quotation"
  TenderItem ||--o{ QuotationItem : "tenderItem"
  Organization ||--o{ Approval : "organization"
  Organization ||--o{ PurchaseOrder : "organization"
  Vendor ||--o{ PurchaseOrder : "vendor"
  Tender |o--o{ PurchaseOrder : "tender"
  Quotation |o--o{ PurchaseOrder : "quotation"
  PurchaseOrder ||--o{ PurchaseOrderItem : "purchaseOrder"
  TenderItem |o--o{ PurchaseOrderItem : "tenderItem"
  PurchaseOrder ||--o{ Delivery : "purchaseOrder"
  Vendor ||--o{ Delivery : "vendor"
  Delivery ||--o{ DeliveryItem : "delivery"
  PurchaseOrderItem ||--o{ DeliveryItem : "purchaseOrderItem"
  Organization ||--o{ Grn : "organization"
  PurchaseOrder ||--o{ Grn : "purchaseOrder"
  Delivery |o--o{ Grn : "delivery"
  Grn ||--o{ GrnItem : "grn"
  PurchaseOrderItem ||--o{ GrnItem : "purchaseOrderItem"
  Organization ||--o{ Invoice : "organization"
  Vendor ||--o{ Invoice : "vendor"
  PurchaseOrder ||--o{ Invoice : "purchaseOrder"
  Invoice ||--o{ InvoiceItem : "invoice"
  PurchaseOrderItem ||--o{ InvoiceItem : "purchaseOrderItem"
  Organization ||--o{ Payment : "organization"
  Vendor ||--o{ Payment : "vendor"
  Invoice ||--o{ Payment : "invoice"
  Organization |o--o{ Document : "organization"
  Vendor |o--o{ Document : "vendor"
  User ||--o{ Notification : "user"
  Organization |o--o{ ActivityLog : "organization"
  User |o--o{ ActivityLog : "actor"
  Organization ||--o{ NumberSequence : "organization"
  Category }o--o{ Vendor : "categories (implicit m2m)"
```

## The item chain

The traceability story in one picture: given any invoice line you can walk back to the tender line
that started it. Note the three derived running totals on `PurchaseOrderItem` — they are what the
three-way match and the fulfilment state are computed from, and no user ever writes them.

```mermaid
erDiagram
    TenderItem {
        int srNo
        string description
        string hsnCode
        string unit
        decimal quantity "18,3 — what was asked for"
        decimal taxRatePercent
        decimal estimatedUnitPrice "internal only"
    }
    QuotationItem {
        decimal quantity "18,3"
        decimal unitPrice "18,2 — sealed until the deadline"
        decimal discountPercent
        decimal taxableValue
        decimal taxAmount
        decimal lineTotal
    }
    PurchaseOrderItem {
        int srNo
        decimal quantity "18,3 — what was ordered"
        decimal unitPrice "18,2 — frozen at issue"
        decimal cgstAmount
        decimal sgstAmount
        decimal igstAmount
        decimal receivedQuantity "derived"
        decimal acceptedQuantity "derived"
        decimal invoicedQuantity "derived"
    }
    DeliveryItem {
        decimal quantity "18,3 — what was dispatched"
    }
    GrnItem {
        decimal receivedQuantity "18,3"
        decimal acceptedQuantity "18,3"
        decimal rejectedQuantity "accepted + rejected = received"
        string rejectionReason
    }
    InvoiceItem {
        decimal quantity "18,3 — what was billed"
        decimal unitPrice "18,2 — matched against the PO"
        decimal taxableValue
        decimal lineTotal
    }

    TenderItem ||--o{ QuotationItem : "vendors bid per line"
    TenderItem |o--o{ PurchaseOrderItem : "awarded line becomes an order line"
    PurchaseOrderItem ||--o{ DeliveryItem : "dispatched in parts"
    PurchaseOrderItem ||--o{ GrnItem : "received in parts"
    PurchaseOrderItem ||--o{ InvoiceItem : "billed in parts"
```

## Reading it

| Notation | Meaning |
|---|---|
| `A ||--o{ B` | every B has exactly one A; an A can have many B |
| `A |o--o{ B` | the link is optional on B (nullable foreign key) |
| `A }o--o{ B` | many-to-many through the implicit `_CategoryToVendor` join table |

25 models, 43 foreign-key relations, plus one implicit many-to-many join table.
