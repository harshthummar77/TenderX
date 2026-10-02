import { Router } from 'express';
import { idParamSchema, PERMISSIONS as P, submitQuotationSchema } from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './quotation.controller.js';

/**
 * Buyer-side bid reads (08 §3).
 *
 * **Every route in this file is covered by the leakage test in
 * `quotation.spec.ts`.** Adding a buyer endpoint here means adding its URL to
 * that test's list. That is deliberate friction: the seal is the one feature of
 * this system that a single careless `include` can destroy, and the test is what
 * notices.
 */
export const quotationBuyerRoutes = Router();

quotationBuyerRoutes.get(
  '/tenders/:id/quotations',
  authenticate,
  requirePermission(P.QUOTATION_VIEW_ALL),
  validate({ params: idParamSchema }),
  controller.listForTender,
);

/** Counts, vendor names, timestamps and seal hashes. Never an amount. */
quotationBuyerRoutes.get(
  '/tenders/:id/bid-summary',
  authenticate,
  requirePermission(P.QUOTATION_VIEW_ALL),
  validate({ params: idParamSchema }),
  controller.bidSummary,
);

quotationBuyerRoutes.get(
  '/quotations/:id',
  authenticate,
  requirePermission(P.QUOTATION_VIEW_ALL),
  validate({ params: idParamSchema }),
  controller.detailForBuyer,
);

/** After opening only — recomputes the seal from the stored rows. */
quotationBuyerRoutes.post(
  '/quotations/:id/verify-seal',
  authenticate,
  requirePermission(P.QUOTATION_VIEW_ALL),
  validate({ params: idParamSchema, body: submitQuotationSchema }),
  controller.verifySeal,
);
