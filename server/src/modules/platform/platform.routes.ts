import { Router } from 'express';
import { idParamSchema, PERMISSIONS as P, platformOrgQuerySchema, reasonSchema } from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './platform.controller.js';
import { system } from './system.controller.js';

export const platformRoutes = Router();

/**
 * Platform-side administration. Note the split: reading tenant data needs
 * PLATFORM_MANAGE, while changing a party's standing needs ORG_APPROVE — and
 * neither grants any permission to create or pay for anything inside a tenant
 * (04 §3).
 */

platformRoutes.get(
  '/platform/organizations',
  authenticate,
  requirePermission(P.PLATFORM_MANAGE),
  validate({ query: platformOrgQuerySchema }),
  controller.listOrganizations,
);

platformRoutes.get(
  '/platform/organizations/:id',
  authenticate,
  requirePermission(P.PLATFORM_MANAGE),
  validate({ params: idParamSchema }),
  controller.getOrganization,
);

platformRoutes.post(
  '/platform/organizations/:id/approve',
  authenticate,
  requirePermission(P.ORG_APPROVE),
  validate({ params: idParamSchema }),
  controller.approve,
);

platformRoutes.post(
  '/platform/organizations/:id/reject',
  authenticate,
  requirePermission(P.ORG_APPROVE),
  validate({ params: idParamSchema, body: reasonSchema }),
  controller.reject,
);

platformRoutes.post(
  '/platform/organizations/:id/suspend',
  authenticate,
  requirePermission(P.ORG_APPROVE),
  validate({ params: idParamSchema, body: reasonSchema }),
  controller.suspend,
);

platformRoutes.get(
  '/platform/stats',
  authenticate,
  requirePermission(P.PLATFORM_MANAGE),
  controller.stats,
);

/** System metrics for the admin screen and any uptime monitor (19 §6). */
platformRoutes.get(
  '/platform/system',
  authenticate,
  requirePermission(P.PLATFORM_MANAGE),
  system,
);
