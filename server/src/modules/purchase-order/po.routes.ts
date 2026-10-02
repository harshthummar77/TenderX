import { Router } from 'express';
import {
  amendPoSchema,
  cancelPoSchema,
  createDirectPoSchema,
  idParamSchema,
  PERMISSIONS as P,
  poQuerySchema,
  submitQuotationSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireActiveOrg } from '../../middleware/requireActiveOrg.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './po.controller.js';

/**
 * Buyer-side purchase orders (10 §4).
 *
 * `PO_ISSUE` and `PO_CANCEL` are both withheld from `ORG_OFFICER` by the role
 * matrix (04 §7): the officer runs the process, the admin commits the
 * organization to spending money. That is the same separation of duties the
 * approval step enforces, one document further down the chain.
 */
export const poRoutes = Router();

poRoutes.get(
  '/purchase-orders',
  authenticate,
  requirePermission(P.PO_VIEW),
  validate({ query: poQuerySchema }),
  controller.list,
);

/** A purchase order with no tender behind it (10 §7). */
poRoutes.post(
  '/purchase-orders',
  authenticate,
  requireActiveOrg,
  requirePermission(P.PO_ISSUE),
  validate({ body: createDirectPoSchema }),
  controller.createDirect,
);

poRoutes.get(
  '/purchase-orders/:id',
  authenticate,
  requirePermission(P.PO_VIEW),
  validate({ params: idParamSchema }),
  controller.detail,
);

poRoutes.get(
  '/purchase-orders/:id/fulfilment',
  authenticate,
  requirePermission(P.PO_VIEW),
  validate({ params: idParamSchema }),
  controller.fulfilment,
);

poRoutes.get(
  '/purchase-orders/:id/pdf',
  authenticate,
  requirePermission(P.PO_VIEW),
  validate({ params: idParamSchema }),
  controller.pdf,
);

poRoutes.post(
  '/purchase-orders/:id/issue',
  authenticate,
  requireActiveOrg,
  requirePermission(P.PO_ISSUE),
  validate({ params: idParamSchema, body: submitQuotationSchema }),
  controller.issue,
);

/** Amend a DRAFT or REJECTED order, then reissue it (10 §5). */
poRoutes.patch(
  '/purchase-orders/:id',
  authenticate,
  requireActiveOrg,
  requirePermission(P.PO_ISSUE),
  validate({ params: idParamSchema, body: amendPoSchema }),
  controller.amend,
);

poRoutes.post(
  '/purchase-orders/:id/cancel',
  authenticate,
  requireActiveOrg,
  requirePermission(P.PO_CANCEL),
  validate({ params: idParamSchema, body: cancelPoSchema }),
  controller.cancel,
);
