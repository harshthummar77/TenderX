import { Router } from 'express';
import { activityQuerySchema, PERMISSIONS as P } from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './activity.controller.js';

/**
 * The activity log (plan 14 §C3).
 *
 * `AUDIT_VIEW` gates the feed and the verification. `/activity/me` deliberately
 * does not: an actor reading their own trail needs no privilege, and withholding
 * it would be the kind of opacity an audit log exists to prevent.
 *
 * The per-row visibility rules — own organization, own vendor, and `SECURITY`
 * rows to platform admins only — live in the service and apply on top of
 * whatever a route allows. `/activity/me` is registered first so it is never
 * read as a query against the general feed.
 */
export const activityRoutes = Router();

activityRoutes.get(
  '/activity/me',
  authenticate,
  validate({ query: activityQuerySchema }),
  controller.mine,
);

activityRoutes.get(
  '/activity',
  authenticate,
  requirePermission(P.AUDIT_VIEW),
  validate({ query: activityQuerySchema }),
  controller.list,
);

activityRoutes.get(
  '/platform/activity/verify',
  authenticate,
  requirePermission(P.AUDIT_VIEW),
  controller.verify,
);

activityRoutes.get(
  '/platform/activity',
  authenticate,
  requirePermission(P.AUDIT_VIEW),
  validate({ query: activityQuerySchema }),
  controller.list,
);
