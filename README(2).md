# TenderBridge — Tender & Vendor Management System

## Project Overview

**TenderBridge** is a web-based tender, procurement, vendor, delivery, invoice, and payment tracking system.  
The platform works as a middle system between **organizations** and **vendors**.

Organizations can create tenders/RFQs, invite vendors, compare quotations, approve the best quotation, generate purchase orders, generate invoices, track delivery, verify received goods, and mark payment status.

This project is inspired by the **VendorBridge Procurement & Vendor Management ERP** problem statement, but the workflow is extended to include post-invoice stages such as delivery confirmation, invoice verification, payment tracking, and tender closure.

---

## Problem Statement

In many organizations, procurement and tender workflows are still managed manually using email, spreadsheets, phone calls, and paper documents. This creates problems such as:

- Unorganized vendor communication
- Difficulty in comparing quotations
- Lack of approval tracking
- Manual purchase order and invoice generation
- No proper delivery confirmation
- No centralized payment status tracking
- Poor audit trail and reporting

TenderBridge solves this by providing a centralized role-based platform for managing the full procurement lifecycle.

---

## Main Objective

To develop a multi-role tender management platform where:

- Platform Admin manages the entire system.
- Organization Admin manages the organization and its officers.
- Organization Officers create tenders/RFQs and compare vendor quotations.
- Vendors submit quotations and update delivery status.
- Organization Admin approves quotations.
- Purchase Orders and Invoices are generated digitally.
- Payment happens only after delivery confirmation and invoice approval.

---

## Actors / User Roles

### 1. Platform Admin

The platform admin is the owner of the website.

Responsibilities:

- Manage organizations
- Manage vendors
- View all platform activities
- Control user access
- Monitor procurement analytics
- Handle system-level administration

---

### 2. Organization Admin

The organization admin is the main account holder for an organization.

Responsibilities:

- Manage organization profile
- Create organization officers
- Approve or reject selected quotations
- View tenders, quotations, purchase orders, invoices, delivery status, and payments
- Close tender after successful completion

---

### 3. Organization Officer

The officer is created by the Organization Admin.

Responsibilities:

- Create tenders/RFQs
- Add product/service details
- Invite vendors
- View submitted quotations
- Compare quotations
- Select best quotation for approval
- Generate purchase order after approval
- Confirm goods delivery
- Verify invoice details

---

### 4. Vendor

The vendor provides goods or services to organizations.

Responsibilities:

- Register and manage vendor profile
- View invited tenders/RFQs
- Submit quotations
- Accept purchase orders
- Update delivery status
- View invoices and payment status

---

## Why Manager Role Is Not Used

The original problem statement includes a **Manager / Approver** role.  
For this college project, that role is merged into **Organization Admin** to keep the workflow simple and practical.

So the final approval flow is:

```text
Organization Officer selects quotation
        ↓
Organization Admin approves or rejects it
```

This reduces complexity while still keeping a proper approval workflow.

---

## Final Procurement Workflow

```text
1. Organization Admin creates Organization Officers
2. Organization Officer creates Tender / RFQ
3. Vendors receive tender invitation
4. Vendors submit quotations
5. Organization Officer compares quotations
6. Organization Officer selects the best quotation
7. Organization Admin approves or rejects selected quotation
8. Approved quotation generates Purchase Order
9. Vendor accepts Purchase Order
10. Invoice is generated from Purchase Order
11. Vendor dispatches goods / provides service
12. Organization Officer confirms delivery
13. Goods Received Note / Delivery Confirmation is created
14. Invoice is verified
15. Payment is marked as pending / partial / paid
16. Tender is closed
```

---

## Important Business Rule

Payment should happen only after the following condition is completed:

```text
PO Accepted
    ↓
Goods Delivered
    ↓
Organization Confirms Delivery
    ↓
Invoice Approved
    ↓
Payment Completed
```

Invoice may be generated after PO, but it should not be considered payable until delivery is confirmed and invoice is approved.

---

## Core Modules

### 1. Authentication Module

Features:

- Login
- Signup
- Forgot password
- JWT authentication
- Password hashing
- Role-based access control
- Session handling

User roles:

- Platform Admin
- Organization Admin
- Organization Officer
- Vendor

---

### 2. Dashboard Module

Different dashboards for different roles.

Platform Admin Dashboard:

- Total organizations
- Total vendors
- Active tenders
- Completed tenders
- Total procurement value

Organization Admin Dashboard:

- Active tenders
- Pending approvals
- Recent purchase orders
- Recent invoices
- Pending payments

Organization Officer Dashboard:

- My created tenders
- Quotation received count
- Pending comparison
- Delivery pending list

Vendor Dashboard:

- Invited tenders
- Submitted quotations
- Accepted POs
- Delivery status
- Payment status

---

### 3. Organization Management Module

Features:

- Organization registration
- Organization profile
- GST number
- Contact details
- Address
- Organization status
- Officer management

---

### 4. Organization Officer Management Module

Features:

- Add officer
- Edit officer
- Activate/deactivate officer
- Assign permissions
- View officer activity

---

### 5. Vendor Management Module

Features:

- Vendor registration
- Vendor category
- GST details
- Contact details
- Vendor status
- Search and filter vendors
- Vendor approval by platform admin

---

### 6. Tender / RFQ Management Module

Features:

- Create tender/RFQ
- Add title
- Add description
- Add product/service details
- Add quantity
- Add budget estimate
- Add deadline
- Upload attachments
- Assign vendors
- Tender status tracking

Tender statuses:

```text
DRAFT
PUBLISHED
QUOTATION_RECEIVED
UNDER_COMPARISON
WAITING_FOR_APPROVAL
APPROVED
PO_GENERATED
INVOICE_GENERATED
DELIVERY_PENDING
DELIVERED
INVOICE_APPROVED
PAYMENT_PENDING
PAYMENT_COMPLETED
CLOSED
CANCELLED
```

---

### 7. Vendor Quotation Module

Features:

- Vendor can submit quotation
- Add price
- Add tax
- Add delivery timeline
- Add notes/comments
- Upload quotation document
- Edit quotation before deadline
- Track quotation status

Quotation statuses:

```text
SUBMITTED
UNDER_REVIEW
SELECTED
REJECTED
APPROVED
```

---

### 8. Quotation Comparison Module

Features:

- Side-by-side quotation comparison
- Lowest price highlighting
- Delivery timeline comparison
- Tax comparison
- Final amount comparison
- Vendor rating/status display
- Sorting and filtering

Comparison factors:

- Price
- Delivery time
- Vendor reliability
- GST/tax details
- Notes and terms
- Total payable amount

---

### 9. Approval Module

Features:

- Organization Admin approves or rejects selected quotation
- Approval remarks
- Approval timestamp
- Approval status tracking
- Approval history

Approval statuses:

```text
PENDING
APPROVED
REJECTED
```

---

### 10. Purchase Order Module

A Purchase Order is generated after Organization Admin approves a quotation.

Features:

- Auto-generated PO number
- Organization details
- Vendor details
- Tender details
- Selected quotation details
- Item details
- Quantity
- Tax calculation
- Total amount
- Delivery deadline
- PO status

PO statuses:

```text
GENERATED
SENT_TO_VENDOR
ACCEPTED_BY_VENDOR
REJECTED_BY_VENDOR
```

---

### 11. Invoice Module

Invoice is generated after Purchase Order generation.

Features:

- Auto-generated invoice number
- Invoice generated from PO
- Tax calculation
- Total amount calculation
- Download invoice as PDF
- Print invoice
- Send invoice by email
- Invoice verification by organization

Invoice statuses:

```text
GENERATED
SENT_TO_ORGANIZATION
UNDER_REVIEW
APPROVED_FOR_PAYMENT
REJECTED
```

---

### 12. Delivery Tracking Module

After PO acceptance, vendor updates delivery progress.

Features:

- Vendor accepts PO
- Vendor updates dispatch status
- Tracking number
- Delivery date
- Delivery proof upload
- Delivery remarks

Delivery statuses:

```text
PO_ACCEPTED
DISPATCHED
IN_TRANSIT
DELIVERED
RECEIVED_CONFIRMED
PARTIALLY_RECEIVED
REJECTED_DAMAGED
```

---

### 13. Goods Received Note / Delivery Confirmation Module

Organization Officer confirms whether goods/services were received properly.

Features:

- Select PO
- View ordered quantity
- Enter received quantity
- Enter damaged quantity
- Upload receiving proof
- Add remarks
- Mark delivery as accepted, partially accepted, or rejected

GRN statuses:

```text
ACCEPTED
PARTIALLY_ACCEPTED
REJECTED
```

---

### 14. Payment Tracking Module

This project does not require real payment gateway integration in MVP.  
Payment can be tracked manually by organization.

Features:

- Payment status update
- Payment amount
- Payment date
- Transaction ID
- Payment method
- Payment proof upload
- Partial payment support
- Final payment confirmation

Payment statuses:

```text
PAYMENT_PENDING
PARTIAL_PAYMENT
PAID
PAYMENT_FAILED
REFUND_REQUIRED
```

Payment should be allowed only when:

```text
Delivery is confirmed
AND
Invoice is approved for payment
```

---

### 15. Activity Logs & Notifications Module

Features:

- RFQ created log
- Vendor invited log
- Quotation submitted log
- Approval/rejection log
- PO generated log
- Invoice generated log
- Delivery updated log
- Payment updated log
- Tender closed log

Notification examples:

- New tender assigned to vendor
- Quotation submitted by vendor
- Approval pending
- PO generated
- Delivery status updated
- Invoice approved
- Payment completed

---

### 16. Reports & Analytics Module

Features:

- Total tenders
- Active tenders
- Closed tenders
- Vendor performance
- Monthly procurement summary
- Payment pending report
- Spending summary
- Exportable reports

---

## MVP Scope

For college project, build these features first:

- Authentication with roles
- Platform Admin dashboard
- Organization Admin dashboard
- Vendor dashboard
- Organization officer creation
- Vendor registration
- Tender/RFQ creation
- Vendor quotation submission
- Quotation comparison
- Approval by Organization Admin
- Purchase Order generation
- Invoice generation
- Delivery confirmation
- Payment status tracking
- Activity logs

---

## Advanced Features / Future Scope

These can be added later:

- Real payment gateway integration
- Vendor rating system
- Multi-level approval hierarchy
- Email notification system
- SMS notification system
- Advanced analytics charts
- AI-based vendor recommendation
- Auto quotation ranking
- Digital signature for PO/invoice
- Multi-organization subscription plans
- Chat system between organization and vendor
- Mobile application

---

## Recommended Tech Stack

### Frontend

- React.js
- Vite
- Tailwind CSS
- shadcn/ui or Material UI
- React Hook Form
- Zod
- Axios
- React Router

### Backend

- Node.js
- Express.js
- JWT Authentication
- bcrypt.js
- Multer for file uploads
- Nodemailer for email
- PDFKit or Puppeteer for invoice PDF generation

### Database

- PostgreSQL
- Prisma ORM

### Deployment

- Frontend: Vercel
- Backend: Render / Railway
- Database: Supabase / Neon / Railway PostgreSQL

---

## Suggested Folder Structure

```text
tenderbridge/
│
├── client/
│   ├── src/
│   │   ├── assets/
│   │   ├── components/
│   │   ├── layouts/
│   │   ├── pages/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── hooks/
│   │   ├── utils/
│   │   └── App.jsx
│   └── package.json
│
├── server/
│   ├── src/
│   │   ├── config/
│   │   ├── controllers/
│   │   ├── middlewares/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── utils/
│   │   └── app.js
│   │
│   ├── prisma/
│   │   └── schema.prisma
│   │
│   └── package.json
│
└── README.md
```

---

## Suggested Database Tables

### users

Stores login details for all users.

Important fields:

- id
- name
- email
- password
- role
- status
- createdAt
- updatedAt

---

### organizations

Stores organization details.

Important fields:

- id
- name
- gstNumber
- email
- phone
- address
- status
- createdAt
- updatedAt

---

### organization_officers

Stores officers created by organization admin.

Important fields:

- id
- organizationId
- userId
- designation
- permissions
- status

---

### vendors

Stores vendor profile details.

Important fields:

- id
- userId
- companyName
- category
- gstNumber
- contactPerson
- phone
- address
- status

---

### tenders

Stores tender/RFQ details.

Important fields:

- id
- organizationId
- createdByOfficerId
- title
- description
- category
- quantity
- budget
- deadline
- status
- createdAt

---

### tender_vendors

Stores vendors invited to a tender.

Important fields:

- id
- tenderId
- vendorId
- invitationStatus

---

### quotations

Stores vendor quotations.

Important fields:

- id
- tenderId
- vendorId
- price
- taxAmount
- totalAmount
- deliveryDays
- notes
- status
- submittedAt

---

### approvals

Stores approval decisions.

Important fields:

- id
- tenderId
- quotationId
- approvedBy
- status
- remarks
- approvedAt

---

### purchase_orders

Stores generated purchase orders.

Important fields:

- id
- poNumber
- tenderId
- quotationId
- organizationId
- vendorId
- totalAmount
- taxAmount
- deliveryDeadline
- status
- createdAt

---

### invoices

Stores invoice details generated from purchase orders.

Important fields:

- id
- invoiceNumber
- poId
- organizationId
- vendorId
- totalAmount
- taxAmount
- status
- generatedAt

---

### deliveries

Stores delivery tracking information.

Important fields:

- id
- poId
- vendorId
- status
- trackingNumber
- expectedDeliveryDate
- deliveredAt
- remarks

---

### goods_received_notes

Stores delivery confirmation records.

Important fields:

- id
- poId
- receivedByOfficerId
- orderedQuantity
- receivedQuantity
- damagedQuantity
- status
- remarks
- receivedAt

---

### payments

Stores payment records.

Important fields:

- id
- invoiceId
- poId
- amountPayable
- amountPaid
- paymentStatus
- paymentDate
- transactionId
- paymentMethod
- remarks

---

### activity_logs

Stores audit logs.

Important fields:

- id
- userId
- action
- module
- description
- createdAt

---

## API Route Suggestions

### Auth Routes

```http
POST /api/auth/register
POST /api/auth/login
POST /api/auth/forgot-password
GET  /api/auth/me
```

### Organization Routes

```http
POST /api/organizations
GET  /api/organizations
GET  /api/organizations/:id
PUT  /api/organizations/:id
```

### Officer Routes

```http
POST /api/officers
GET  /api/officers
PUT  /api/officers/:id
DELETE /api/officers/:id
```

### Vendor Routes

```http
POST /api/vendors
GET  /api/vendors
GET  /api/vendors/:id
PUT  /api/vendors/:id
```

### Tender Routes

```http
POST /api/tenders
GET  /api/tenders
GET  /api/tenders/:id
PUT  /api/tenders/:id
POST /api/tenders/:id/invite-vendors
```

### Quotation Routes

```http
POST /api/quotations
GET  /api/tenders/:id/quotations
PUT  /api/quotations/:id
```

### Approval Routes

```http
POST /api/approvals
PUT  /api/approvals/:id/approve
PUT  /api/approvals/:id/reject
```

### Purchase Order Routes

```http
POST /api/purchase-orders
GET  /api/purchase-orders
GET  /api/purchase-orders/:id
PUT  /api/purchase-orders/:id/accept
```

### Invoice Routes

```http
POST /api/invoices
GET  /api/invoices
GET  /api/invoices/:id
GET  /api/invoices/:id/download
PUT  /api/invoices/:id/approve
PUT  /api/invoices/:id/reject
```

### Delivery Routes

```http
POST /api/deliveries
GET  /api/deliveries/:poId
PUT  /api/deliveries/:id/status
POST /api/goods-received-notes
```

### Payment Routes

```http
POST /api/payments
GET  /api/payments
GET  /api/payments/:id
PUT  /api/payments/:id/status
```

### Activity Log Routes

```http
GET /api/activity-logs
GET /api/activity-logs/:module
```

---

## Access Control Summary

| Feature | Platform Admin | Organization Admin | Organization Officer | Vendor |
|---|---|---|---|---|
| Manage organizations | Yes | No | No | No |
| Manage vendors | Yes | View only | View invited vendors | Own profile only |
| Create officers | No | Yes | No | No |
| Create tender/RFQ | No | Yes | Yes | No |
| Submit quotation | No | No | No | Yes |
| Compare quotations | No | Yes | Yes | No |
| Approve quotation | No | Yes | No | No |
| Generate PO | No | Yes | Yes, after approval | No |
| Accept PO | No | No | No | Yes |
| Generate invoice | No | Yes | Yes | View only |
| Confirm delivery | No | Yes | Yes | No |
| Update delivery | No | No | No | Yes |
| Update payment | No | Yes | No | View only |
| View reports | Yes | Yes | Limited | No |

---

## UI Pages

### Public Pages

- Landing Page
- Login
- Signup
- Forgot Password

### Platform Admin Pages

- Admin Dashboard
- Organizations
- Vendors
- Users
- Reports
- Activity Logs

### Organization Admin Pages

- Organization Dashboard
- Officers
- Tenders
- Quotations
- Approvals
- Purchase Orders
- Invoices
- Deliveries
- Payments
- Reports

### Organization Officer Pages

- Officer Dashboard
- Create Tender
- Tender List
- Quotation Comparison
- Purchase Orders
- Delivery Confirmation
- Invoice Verification

### Vendor Pages

- Vendor Dashboard
- Invited Tenders
- Submit Quotation
- Purchase Orders
- Delivery Status
- Payment Status

---

## College Project Presentation Points

Use these points while explaining the project:

- This is not a simple CRUD project.
- It solves a real procurement problem.
- It has multiple user roles.
- It includes role-based access control.
- It has a complete tender lifecycle.
- It includes quotation comparison and approval.
- It generates purchase orders and invoices.
- It tracks delivery before payment.
- It maintains activity logs for audit.
- It can be expanded into a real ERP system.

---

## How To Run The Project

### 1. Clone the repository

```bash
git clone https://github.com/your-username/tenderbridge.git
cd tenderbridge
```

### 2. Install frontend dependencies

```bash
cd client
npm install
npm run dev
```

### 3. Install backend dependencies

```bash
cd server
npm install
npm run dev
```

### 4. Setup environment variables

Create `.env` file inside the server folder.

```env
DATABASE_URL="postgresql://username:password@localhost:5432/tenderbridge"
JWT_SECRET="your_jwt_secret"
EMAIL_USER="your_email@example.com"
EMAIL_PASS="your_email_password"
```

### 5. Run Prisma migration

```bash
npx prisma migrate dev
npx prisma generate
```

---

## Expected Output

After completion, the system should allow:

- Organization registration
- Vendor registration
- Officer creation by organization admin
- Tender/RFQ creation
- Vendor quotation submission
- Quotation comparison
- Organization admin approval
- Purchase order generation
- Invoice generation
- Delivery confirmation
- Invoice approval
- Payment status tracking
- Tender closure
- Activity log tracking

---

## Conclusion

TenderBridge is a suitable and strong college project because it includes real-world business logic, multiple roles, database relationships, authentication, workflows, document generation, and status tracking.

The project can be built as a medium-level MVP first and later expanded into a full procurement ERP system.

---

## Project Status

```text
Research and planning completed.
Ready for database design, UI design, and implementation.
```
