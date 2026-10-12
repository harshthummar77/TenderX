# API reference

Generated on **2026-10-10** by `server/scripts/generate-api-doc.ts`. Do not hand-edit — rerun the script.

Every path is prefixed with `/api/v1`. The *Guard* column names the middleware on each route, in order.

**150 routes** across 23 modules.

## activity

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/activity` | authenticate · permissionGuard |
| `GET` | `/api/v1/activity/me` | authenticated |

## approvals

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/approvals` | authenticate · permissionGuard |
| `GET` | `/api/v1/approvals/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/approvals/:id/decide` | authenticate · permissionGuard |

## auth

| Method | Path | Guard |
|---|---|---|
| `POST` | `/api/v1/auth/change-password` | authenticated |
| `POST` | `/api/v1/auth/forgot-password` | public |
| `POST` | `/api/v1/auth/login` | public |
| `POST` | `/api/v1/auth/logout` | authenticated |
| `POST` | `/api/v1/auth/logout-all` | authenticated |
| `GET` | `/api/v1/auth/me` | authenticated |
| `PATCH` | `/api/v1/auth/me` | authenticated |
| `POST` | `/api/v1/auth/refresh` | public |
| `POST` | `/api/v1/auth/register/organization` | public |
| `POST` | `/api/v1/auth/register/vendor` | public |
| `POST` | `/api/v1/auth/reset-password` | public |

## categories

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/categories` | authenticate · permissionGuard |
| `POST` | `/api/v1/categories` | authenticate · permissionGuard |

## dashboard

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/dashboard` | authenticated |

## deliveries

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/deliveries/:id` | authenticate · permissionGuard |

## documents

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/documents` | authenticated |
| `POST` | `/api/v1/documents` | authenticate · permissionGuard |
| `DELETE` | `/api/v1/documents/:id` | authenticate · permissionGuard |
| `GET` | `/api/v1/documents/:id` | authenticated |
| `GET` | `/api/v1/documents/:id/download` | authenticated |

## grns

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/grns` | authenticate · permissionGuard |
| `GET` | `/api/v1/grns/:id` | authenticate · permissionGuard |

## health

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/health` | public |

## invitations

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/invitations` | authenticate · permissionGuard |
| `POST` | `/api/v1/invitations` | authenticate · permissionGuard |
| `DELETE` | `/api/v1/invitations/:id` | authenticate · permissionGuard |
| `GET` | `/api/v1/invitations/:token` | public |
| `POST` | `/api/v1/invitations/:token/accept` | public |

## invoices

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/invoices` | authenticate · permissionGuard |
| `GET` | `/api/v1/invoices/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/invoices/:id/approve` | authenticate · permissionGuard |
| `POST` | `/api/v1/invoices/:id/override-match` | authenticate · permissionGuard |
| `GET` | `/api/v1/invoices/:id/pdf` | authenticate · permissionGuard |
| `POST` | `/api/v1/invoices/:id/reject` | authenticate · permissionGuard |
| `POST` | `/api/v1/invoices/:id/rematch` | authenticate · permissionGuard |
| `GET` | `/api/v1/invoices/ageing` | authenticate · permissionGuard |
| `GET` | `/api/v1/invoices/match-exceptions` | authenticate · permissionGuard |

## me

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/me/notification-preferences` | authenticated |

## notifications

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/notifications` | authenticated |
| `POST` | `/api/v1/notifications/:id/read` | authenticated |
| `POST` | `/api/v1/notifications/read-all` | authenticated |
| `GET` | `/api/v1/notifications/unread-count` | authenticated |

## organizations

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/organizations/me` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/organizations/me` | authenticate · permissionGuard |
| `GET` | `/api/v1/organizations/me/members` | authenticate · permissionGuard |
| `DELETE` | `/api/v1/organizations/me/members/:userId` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/organizations/me/members/:userId` | authenticate · permissionGuard |
| `POST` | `/api/v1/organizations/me/members/invite` | authenticate · permissionGuard |
| `GET` | `/api/v1/organizations/me/settings` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/organizations/me/settings` | authenticate · permissionGuard |

## payments

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/payments` | authenticate · permissionGuard |
| `POST` | `/api/v1/payments` | authenticate · permissionGuard |
| `GET` | `/api/v1/payments/:id` | authenticate · permissionGuard |
| `GET` | `/api/v1/payments/:id/advice` | authenticate · permissionGuard |
| `POST` | `/api/v1/payments/:id/cancel` | authenticate · permissionGuard |
| `POST` | `/api/v1/payments/:id/complete` | authenticate · permissionGuard |
| `POST` | `/api/v1/payments/:id/fail` | authenticate · permissionGuard |
| `GET` | `/api/v1/payments/payable` | authenticate · permissionGuard |

## platform

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/platform/activity` | authenticate · permissionGuard |
| `GET` | `/api/v1/platform/activity/verify` | authenticate · permissionGuard |
| `GET` | `/api/v1/platform/organizations` | authenticate · permissionGuard |
| `GET` | `/api/v1/platform/organizations/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/platform/organizations/:id/approve` | authenticate · permissionGuard |
| `POST` | `/api/v1/platform/organizations/:id/reject` | authenticate · permissionGuard |
| `POST` | `/api/v1/platform/organizations/:id/suspend` | authenticate · permissionGuard |
| `GET` | `/api/v1/platform/stats` | authenticate · permissionGuard |
| `GET` | `/api/v1/platform/system` | authenticate · permissionGuard |
| `GET` | `/api/v1/platform/vendors` | authenticate · permissionGuard |
| `GET` | `/api/v1/platform/vendors/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/platform/vendors/:id/approve` | authenticate · permissionGuard |
| `POST` | `/api/v1/platform/vendors/:id/blacklist` | authenticate · permissionGuard |
| `POST` | `/api/v1/platform/vendors/:id/reinstate` | authenticate · permissionGuard |
| `POST` | `/api/v1/platform/vendors/:id/reject` | authenticate · permissionGuard |
| `POST` | `/api/v1/platform/vendors/:id/suspend` | authenticate · permissionGuard |

## purchase-orders

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/purchase-orders` | authenticate · permissionGuard |
| `POST` | `/api/v1/purchase-orders` | authenticate · permissionGuard |
| `GET` | `/api/v1/purchase-orders/:id` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/purchase-orders/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/purchase-orders/:id/cancel` | authenticate · permissionGuard |
| `GET` | `/api/v1/purchase-orders/:id/fulfilment` | authenticate · permissionGuard |
| `POST` | `/api/v1/purchase-orders/:id/issue` | authenticate · permissionGuard |
| `GET` | `/api/v1/purchase-orders/:id/pdf` | authenticate · permissionGuard |
| `POST` | `/api/v1/purchase-orders/:poId/grns` | authenticate · permissionGuard |
| `GET` | `/api/v1/purchase-orders/:poId/receivable` | authenticate · permissionGuard |
| `POST` | `/api/v1/purchase-orders/:poId/short-close` | authenticate · permissionGuard |

## quotations

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/quotations/:id` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/quotations/:id/scores` | authenticate · permissionGuard |
| `POST` | `/api/v1/quotations/:id/verify-seal` | authenticate · permissionGuard |

## ready

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/ready` | public |

## reports

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/reports/match-exceptions` | authenticate · permissionGuard |
| `GET` | `/api/v1/reports/spend` | authenticate · permissionGuard |
| `GET` | `/api/v1/reports/tenders` | authenticate · permissionGuard |
| `GET` | `/api/v1/reports/vendor-performance` | authenticate · permissionGuard |

## tenders

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/tenders` | authenticate · permissionGuard |
| `POST` | `/api/v1/tenders` | authenticate · permissionGuard |
| `DELETE` | `/api/v1/tenders/:id` | authenticate · permissionGuard |
| `GET` | `/api/v1/tenders/:id` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/tenders/:id` | authenticate · permissionGuard |
| `GET` | `/api/v1/tenders/:id/bid-summary` | authenticate · permissionGuard |
| `POST` | `/api/v1/tenders/:id/cancel` | authenticate · permissionGuard |
| `POST` | `/api/v1/tenders/:id/close-bidding` | authenticate · permissionGuard |
| `GET` | `/api/v1/tenders/:id/comparison` | authenticate · permissionGuard |
| `GET` | `/api/v1/tenders/:id/comparison/export` | authenticate · permissionGuard |
| `POST` | `/api/v1/tenders/:id/evaluation/open` | authenticate · permissionGuard |
| `POST` | `/api/v1/tenders/:id/evaluation/recalculate` | authenticate · permissionGuard |
| `GET` | `/api/v1/tenders/:id/invitations` | authenticate · permissionGuard |
| `POST` | `/api/v1/tenders/:id/invitations` | authenticate · permissionGuard |
| `DELETE` | `/api/v1/tenders/:id/invitations/:vendorId` | authenticate · permissionGuard |
| `POST` | `/api/v1/tenders/:id/publish` | authenticate · permissionGuard |
| `GET` | `/api/v1/tenders/:id/quotations` | authenticate · permissionGuard |
| `POST` | `/api/v1/tenders/:id/recommend` | authenticate · permissionGuard |
| `GET` | `/api/v1/tenders/:id/suggested-vendors` | authenticate · permissionGuard |

## vendor (own data)

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/vendor/deliveries` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/vendor/deliveries/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/deliveries/:id/cancel` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/invoices` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/invoices/:id` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/vendor/invoices/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/invoices/:id/submit` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/payments` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/purchase-orders` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/purchase-orders/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/purchase-orders/:id/accept` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/purchase-orders/:id/reject` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/purchase-orders/:poId/deliveries` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/purchase-orders/:poId/invoiceable` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/purchase-orders/:poId/invoices` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/quotations` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/quotations/:id` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/vendor/quotations/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/quotations/:id/revise` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/quotations/:id/submit` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/quotations/:id/withdraw` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/tenders` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendor/tenders/:id` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/tenders/:id/decline` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendor/tenders/:tenderId/quotation` | authenticate · permissionGuard |

## vendors

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/v1/vendors` | authenticate · permissionGuard |
| `POST` | `/api/v1/vendors` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendors/:id` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendors/:id/scorecard` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendors/me` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/vendors/me` | authenticate · permissionGuard |
| `PATCH` | `/api/v1/vendors/me/categories` | authenticate · permissionGuard |
| `GET` | `/api/v1/vendors/me/scorecard` | authenticate · permissionGuard |

---

`authenticated` means `authenticate` with no further permission check: these are own-account endpoints where ownership is enforced in the service rather than by a permission (see [security.md](security.md#identity-vs-tenant-routes)).
