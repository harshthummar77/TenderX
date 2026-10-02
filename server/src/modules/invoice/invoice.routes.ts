import { Router } from 'express';
import {
  approveInvoiceSchema,
  idParamSchema,
  invoiceQuerySchema,
  overrideMatchSchema,
  PERMISSIONS as P,
  rejectInvoiceSchema,
  submitInvoiceSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireActiveOrg } from '../../middleware/requireActiveOrg.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './invoice.controller.js';

/**
 * Buyer-side invoice handling (plan 12 §4).
 *
 * The separation of duties runs through the permission matrix: `INVOICE_VIEW`
 * is held by both organization roles, but `INVOICE_APPROVE` and
 * `INVOICE_OVERRIDE` are `ORG_ADMIN` only. An officer can read the match
 * checklist and chase the vendor; only an admin can commit the organization to
 * paying something, and only an admin can wave an exception through.
 *
 * Static paths are registered before `/invoices/:id` so `ageing` and
 * `match-exceptions` are not swallowed as ids.
 */
export const invoiceRoutes = Router();

invoiceRoutes.get(
  '/invoices',
  authenticate,
  requirePermission(P.INVOICE_VIEW),
  validate({ query: invoiceQuerySchema }),
  controller.list,
);

invoiceRoutes.get(
  '/invoices/ageing',
  authenticate,
  requirePermission(P.INVOICE_VIEW),
  controller.ageingReport,
);

/** The report an auditor reads: every exception and every override. */
invoiceRoutes.get(
  '/invoices/match-exceptions',
  authenticate,
  requirePermission(P.INVOICE_VIEW),
  controller.matchExceptions,
);

invoiceRoutes.get(
  '/invoices/:id',
  authenticate,
  requirePermission(P.INVOICE_VIEW),
  validate({ params: idParamSchema }),
  controller.detail,
);

invoiceRoutes.get(
  '/invoices/:id/pdf',
  authenticate,
  requirePermission(P.INVOICE_VIEW),
  validate({ params: idParamSchema }),
  controller.pdf,
);

/** Re-run the match after the missing piece — usually a GRN — turns up. */
invoiceRoutes.post(
  '/invoices/:id/rematch',
  authenticate,
  requireActiveOrg,
  requirePermission(P.INVOICE_VIEW),
  validate({ params: idParamSchema, body: submitInvoiceSchema }),
  controller.rematch,
);

invoiceRoutes.post(
  '/invoices/:id/approve',
  authenticate,
  requireActiveOrg,
  requirePermission(P.INVOICE_APPROVE),
  validate({ params: idParamSchema, body: approveInvoiceSchema }),
  controller.approve,
);

invoiceRoutes.post(
  '/invoices/:id/reject',
  authenticate,
  requireActiveOrg,
  requirePermission(P.INVOICE_APPROVE),
  validate({ params: idParamSchema, body: rejectInvoiceSchema }),
  controller.reject,
);

invoiceRoutes.post(
  '/invoices/:id/override-match',
  authenticate,
  requireActiveOrg,
  requirePermission(P.INVOICE_OVERRIDE),
  validate({ params: idParamSchema, body: overrideMatchSchema }),
  controller.override,
);
