import { Router } from 'express';
import { z } from 'zod';
import {
  createGrnSchema,
  grnQuerySchema,
  idParamSchema,
  PERMISSIONS as P,
  shortCloseSchema,
  uuidSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireActiveOrg } from '../../middleware/requireActiveOrg.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './grn.controller.js';

/** Shared by the GRN routes and the vendor delivery route under the same prefix. */
export const poIdParamSchema = z.object({ poId: uuidSchema }).strict();

/**
 * Goods receipt (plan 11 §3).
 *
 * `GRN_CREATE` is held by both organization roles — receiving goods is the
 * officer's job, and the storekeeper is not an admin. `short-close` deliberately
 * needs `PO_ISSUE`, which `ORG_OFFICER` does not hold: writing off contracted
 * goods is a financial decision, so it takes an admin (plan 11 §5).
 *
 * Reads are `PO_VIEW`, so a vendor can see what was receipted against their own
 * order — including the rejections, which are the only thing they can act on.
 */
export const grnRoutes = Router();

grnRoutes.get(
  '/purchase-orders/:poId/receivable',
  authenticate,
  requirePermission(P.GRN_CREATE),
  validate({ params: poIdParamSchema }),
  controller.receivable,
);

grnRoutes.post(
  '/purchase-orders/:poId/grns',
  authenticate,
  requireActiveOrg,
  requirePermission(P.GRN_CREATE),
  validate({ params: poIdParamSchema, body: createGrnSchema }),
  controller.create,
);

grnRoutes.post(
  '/purchase-orders/:poId/short-close',
  authenticate,
  requireActiveOrg,
  requirePermission(P.PO_ISSUE),
  validate({ params: poIdParamSchema, body: shortCloseSchema }),
  controller.shortClose,
);

grnRoutes.get(
  '/grns',
  authenticate,
  requirePermission(P.PO_VIEW),
  validate({ query: grnQuerySchema }),
  controller.list,
);

grnRoutes.get(
  '/grns/:id',
  authenticate,
  requirePermission(P.PO_VIEW),
  validate({ params: idParamSchema }),
  controller.detail,
);
