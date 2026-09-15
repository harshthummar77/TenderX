import { Router } from 'express';
import { createCategorySchema, PERMISSIONS as P } from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from '../vendor/vendor.controller.js';

export const categoryRoutes = Router();

/**
 * Flat, platform-wide classification shared by vendors and tenders. Anyone
 * signed in can read the list — a buyer picks one on a tender, a vendor picks
 * several on its profile — but only the platform maintains it.
 */
categoryRoutes.get(
  '/categories',
  authenticate,
  // A buyer reads the list to classify a tender; a vendor reads it to classify
  // itself. VENDOR_VIEW alone would lock vendors out of their own profile.
  requireAnyPermission(P.VENDOR_VIEW, P.VENDOR_UPDATE_SELF, P.PLATFORM_MANAGE),
  controller.listCategories,
);

categoryRoutes.post(
  '/categories',
  authenticate,
  requirePermission(P.PLATFORM_MANAGE),
  validate({ body: createCategorySchema }),
  controller.createCategory,
);
