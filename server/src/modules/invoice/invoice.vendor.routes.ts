import { Router } from 'express';
import {
  createInvoiceSchema,
  idParamSchema,
  invoiceQuerySchema,
  PERMISSIONS as P,
  submitInvoiceSchema,
  updateInvoiceSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireVendorNotRejected } from '../../middleware/requireApprovedVendor.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import { poIdParamSchema } from '../grn/grn.routes.js';
import * as controller from './invoice.controller.js';

/**
 * Vendor-side invoicing (plan 12 §4).
 *
 * **The supplier raises the invoice** — that inversion is the point of the
 * module, and it is why there is no buyer route that creates one.
 *
 * Writes carry `requireVendorNotRejected`, the loosest of the three vendor gates
 * (06 §1): billing for goods already delivered is money owed, not new business.
 * A suspended vendor must still be able to invoice work they have done, or the
 * organization is simply refusing to pay its debts.
 */
export const invoiceVendorRoutes = Router();

invoiceVendorRoutes.get(
  '/vendor/purchase-orders/:poId/invoiceable',
  authenticate,
  requirePermission(P.INVOICE_SUBMIT),
  validate({ params: poIdParamSchema }),
  controller.invoiceable,
);

invoiceVendorRoutes.post(
  '/vendor/purchase-orders/:poId/invoices',
  authenticate,
  requireVendorNotRejected,
  requirePermission(P.INVOICE_SUBMIT),
  validate({ params: poIdParamSchema, body: createInvoiceSchema }),
  controller.create,
);

invoiceVendorRoutes.get(
  '/vendor/invoices',
  authenticate,
  requirePermission(P.INVOICE_VIEW),
  validate({ query: invoiceQuerySchema }),
  controller.listMine,
);

invoiceVendorRoutes.get(
  '/vendor/invoices/:id',
  authenticate,
  requirePermission(P.INVOICE_VIEW),
  validate({ params: idParamSchema }),
  controller.detail,
);

invoiceVendorRoutes.patch(
  '/vendor/invoices/:id',
  authenticate,
  requireVendorNotRejected,
  requirePermission(P.INVOICE_SUBMIT),
  validate({ params: idParamSchema, body: updateInvoiceSchema }),
  controller.update,
);

/** Runs the three-way match. */
invoiceVendorRoutes.post(
  '/vendor/invoices/:id/submit',
  authenticate,
  requireVendorNotRejected,
  requirePermission(P.INVOICE_SUBMIT),
  validate({ params: idParamSchema, body: submitInvoiceSchema }),
  controller.submit,
);
