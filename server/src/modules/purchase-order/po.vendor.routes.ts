import { Router } from 'express';
import {
  acceptPoSchema,
  idParamSchema,
  PERMISSIONS as P,
  poQuerySchema,
  rejectPoSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireVendorCanFulfil } from '../../middleware/requireApprovedVendor.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './po.controller.js';

/**
 * Vendor-side purchase orders (10 §4).
 *
 * Responding carries `requireVendorCanFulfil`, not `requireApprovedVendor`:
 * accepting or rejecting an order that already exists is **honouring an existing
 * obligation**, not new business (06 §1). A vendor suspended after the order went
 * out may still answer it — suspension stops new work, it does not repudiate a
 * contract already on the table.
 */
export const poVendorRoutes = Router();

poVendorRoutes.get(
  '/vendor/purchase-orders',
  authenticate,
  requirePermission(P.PO_VIEW),
  validate({ query: poQuerySchema }),
  controller.listMine,
);

poVendorRoutes.get(
  '/vendor/purchase-orders/:id',
  authenticate,
  requirePermission(P.PO_VIEW),
  validate({ params: idParamSchema }),
  controller.detail,
);

poVendorRoutes.post(
  '/vendor/purchase-orders/:id/accept',
  authenticate,
  requireVendorCanFulfil,
  requirePermission(P.PO_RESPOND),
  validate({ params: idParamSchema, body: acceptPoSchema }),
  controller.accept,
);

poVendorRoutes.post(
  '/vendor/purchase-orders/:id/reject',
  authenticate,
  requireVendorCanFulfil,
  requirePermission(P.PO_RESPOND),
  validate({ params: idParamSchema, body: rejectPoSchema }),
  controller.reject,
);
