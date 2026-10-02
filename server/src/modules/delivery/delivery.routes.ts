import { Router } from 'express';
import {
  cancelDeliverySchema,
  createDeliverySchema,
  deliveryQuerySchema,
  idParamSchema,
  PERMISSIONS as P,
  updateDeliverySchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireVendorCanFulfil } from '../../middleware/requireApprovedVendor.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import { poIdParamSchema } from '../grn/grn.routes.js';
import * as controller from './delivery.controller.js';

/**
 * Deliveries (plan 11 §2).
 *
 * Writes carry `requireVendorCanFulfil`, not `requireApprovedVendor`: shipping
 * against an order that already exists is honouring an existing obligation, not
 * new business (06 §1). A vendor suspended after the order was accepted must
 * still be able to deliver what they owe.
 *
 * `GET /deliveries/:id` is open to both parties — the vendor raised the challan,
 * the buyer has to receipt it.
 */
export const deliveryRoutes = Router();

deliveryRoutes.get(
  '/vendor/deliveries',
  authenticate,
  requirePermission(P.DELIVERY_CREATE),
  validate({ query: deliveryQuerySchema }),
  controller.listMine,
);

deliveryRoutes.post(
  '/vendor/purchase-orders/:poId/deliveries',
  authenticate,
  requireVendorCanFulfil,
  requirePermission(P.DELIVERY_CREATE),
  validate({ params: poIdParamSchema, body: createDeliverySchema }),
  controller.create,
);

/** Correctable only until the buyer receipts it — after that it is evidence. */
deliveryRoutes.patch(
  '/vendor/deliveries/:id',
  authenticate,
  requireVendorCanFulfil,
  requirePermission(P.DELIVERY_CREATE),
  validate({ params: idParamSchema, body: updateDeliverySchema }),
  controller.update,
);

deliveryRoutes.post(
  '/vendor/deliveries/:id/cancel',
  authenticate,
  requireVendorCanFulfil,
  requirePermission(P.DELIVERY_CREATE),
  validate({ params: idParamSchema, body: cancelDeliverySchema }),
  controller.cancel,
);

deliveryRoutes.get(
  '/deliveries/:id',
  authenticate,
  requirePermission(P.PO_VIEW),
  validate({ params: idParamSchema }),
  controller.detail,
);
