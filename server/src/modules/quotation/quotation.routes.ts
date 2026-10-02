import { Router } from 'express';
import {
  idParamSchema,
  PERMISSIONS as P,
  quotationDraftSchema,
  quotationQuerySchema,
  submitQuotationSchema,
  tenderIdParamSchema,
  withdrawQuotationSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireApprovedVendor } from '../../middleware/requireApprovedVendor.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './quotation.controller.js';

/**
 * Vendor-side bidding (08 §3).
 *
 * Every write carries `requireApprovedVendor`: pricing a tender is new business,
 * and a suspended vendor does not get to start any (06 §1). Reads are left open
 * to any vendor status — a suspended vendor may still look at what they bid.
 */
export const quotationRoutes = Router();

quotationRoutes.get(
  '/vendor/quotations',
  authenticate,
  requirePermission(P.QUOTATION_VIEW_OWN),
  validate({ query: quotationQuerySchema }),
  controller.listMine,
);

quotationRoutes.post(
  '/vendor/tenders/:tenderId/quotation',
  authenticate,
  requireApprovedVendor,
  requirePermission(P.QUOTATION_SUBMIT),
  validate({ params: tenderIdParamSchema }),
  controller.openDraft,
);

quotationRoutes.get(
  '/vendor/quotations/:id',
  authenticate,
  requirePermission(P.QUOTATION_VIEW_OWN),
  validate({ params: idParamSchema }),
  controller.detailMine,
);

/** The autosave target. DRAFT only, and every figure is recomputed server-side. */
quotationRoutes.patch(
  '/vendor/quotations/:id',
  authenticate,
  requireApprovedVendor,
  requirePermission(P.QUOTATION_SUBMIT),
  validate({ params: idParamSchema, body: quotationDraftSchema }),
  controller.saveDraft,
);

quotationRoutes.post(
  '/vendor/quotations/:id/submit',
  authenticate,
  requireApprovedVendor,
  requirePermission(P.QUOTATION_SUBMIT),
  validate({ params: idParamSchema, body: submitQuotationSchema }),
  controller.submit,
);

quotationRoutes.post(
  '/vendor/quotations/:id/withdraw',
  authenticate,
  requireApprovedVendor,
  requirePermission(P.QUOTATION_SUBMIT),
  validate({ params: idParamSchema, body: withdrawQuotationSchema }),
  controller.withdraw,
);

quotationRoutes.post(
  '/vendor/quotations/:id/revise',
  authenticate,
  requireApprovedVendor,
  requirePermission(P.QUOTATION_SUBMIT),
  validate({ params: idParamSchema, body: submitQuotationSchema }),
  controller.revise,
);
