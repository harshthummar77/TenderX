import { Router } from 'express';
import {
  createVendorSchema,
  idParamSchema,
  PERMISSIONS as P,
  reasonSchema,
  updateVendorCategoriesSchema,
  updateVendorSchema,
  vendorQuerySchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './vendor.controller.js';

export const vendorRoutes = Router();

/**
 * Note what is NOT gated by vendor status: everything here. Profile, documents
 * and categories stay open at every status, exactly as the org profile does —
 * a vendor must be able to fix its KYC while pending, or approval is
 * unreachable. The status gates (`requireApprovedVendor` and friends) belong on
 * the business routes of plans 08–13.
 */

/* ------------------------------------------------------------ self-service */

vendorRoutes.get(
  '/vendors/me',
  authenticate,
  requirePermission(P.VENDOR_UPDATE_SELF),
  controller.getOwnVendor,
);

vendorRoutes.patch(
  '/vendors/me',
  authenticate,
  requirePermission(P.VENDOR_UPDATE_SELF),
  validate({ body: updateVendorSchema }),
  controller.updateOwnVendor,
);

vendorRoutes.patch(
  '/vendors/me/categories',
  authenticate,
  requirePermission(P.VENDOR_UPDATE_SELF),
  validate({ body: updateVendorCategoriesSchema }),
  controller.setOwnCategories,
);

vendorRoutes.get(
  '/vendors/me/scorecard',
  authenticate,
  requirePermission(P.VENDOR_UPDATE_SELF),
  controller.getOwnScorecard,
);

/* -------------------------------------------------------------- buyer side */

vendorRoutes.get(
  '/vendors',
  authenticate,
  requirePermission(P.VENDOR_VIEW),
  validate({ query: vendorQuerySchema }),
  controller.listVendors,
);

vendorRoutes.post(
  '/vendors',
  authenticate,
  requirePermission(P.VENDOR_CREATE),
  validate({ body: createVendorSchema }),
  controller.createVendor,
);

vendorRoutes.get(
  '/vendors/:id',
  authenticate,
  requirePermission(P.VENDOR_VIEW),
  validate({ params: idParamSchema }),
  controller.getVendor,
);

vendorRoutes.get(
  '/vendors/:id/scorecard',
  authenticate,
  requirePermission(P.VENDOR_VIEW),
  validate({ params: idParamSchema }),
  controller.getScorecard,
);

/* ---------------------------------------------------------- platform admin */

vendorRoutes.get(
  '/platform/vendors',
  authenticate,
  requirePermission(P.VENDOR_VIEW),
  validate({ query: vendorQuerySchema }),
  controller.listPlatformVendors,
);

vendorRoutes.get(
  '/platform/vendors/:id',
  authenticate,
  requirePermission(P.VENDOR_VIEW),
  validate({ params: idParamSchema }),
  controller.getPlatformVendor,
);

vendorRoutes.post(
  '/platform/vendors/:id/approve',
  authenticate,
  requirePermission(P.VENDOR_APPROVE),
  validate({ params: idParamSchema }),
  controller.approve,
);

vendorRoutes.post(
  '/platform/vendors/:id/reject',
  authenticate,
  requirePermission(P.VENDOR_APPROVE),
  validate({ params: idParamSchema, body: reasonSchema }),
  controller.reject,
);

vendorRoutes.post(
  '/platform/vendors/:id/suspend',
  authenticate,
  requirePermission(P.VENDOR_APPROVE),
  validate({ params: idParamSchema, body: reasonSchema }),
  controller.suspend,
);

vendorRoutes.post(
  '/platform/vendors/:id/reinstate',
  authenticate,
  requirePermission(P.VENDOR_APPROVE),
  validate({ params: idParamSchema }),
  controller.reinstate,
);

/** Irreversible — the state machine has no transition out of BLACKLISTED. */
vendorRoutes.post(
  '/platform/vendors/:id/blacklist',
  authenticate,
  requirePermission(P.VENDOR_BLACKLIST),
  validate({ params: idParamSchema, body: reasonSchema }),
  controller.blacklist,
);
