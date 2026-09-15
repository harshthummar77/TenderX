import { Router } from 'express';
import {
  inviteMemberSchema,
  memberParamSchema,
  PERMISSIONS as P,
  updateMemberSchema,
  updateOrgSchema,
  updateSettingsSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './organization.controller.js';

export const organizationRoutes = Router();

/**
 * Note what is NOT here: `requireActiveOrg`. A pending organization must be able
 * to complete its profile and upload KYC documents, or it can never reach the
 * state where approval is possible (05 §1). The gate goes on the business
 * routes in plans 07-15.
 */

organizationRoutes.get(
  '/organizations/me',
  authenticate,
  requirePermission(P.ORG_VIEW),
  controller.getOrg,
);

organizationRoutes.patch(
  '/organizations/me',
  authenticate,
  requirePermission(P.ORG_UPDATE),
  validate({ body: updateOrgSchema }),
  controller.updateOrg,
);

organizationRoutes.get(
  '/organizations/me/settings',
  authenticate,
  requirePermission(P.ORG_VIEW),
  controller.getSettings,
);

organizationRoutes.patch(
  '/organizations/me/settings',
  authenticate,
  requirePermission(P.ORG_UPDATE),
  validate({ body: updateSettingsSchema }),
  controller.updateSettings,
);

organizationRoutes.get(
  '/organizations/me/members',
  authenticate,
  requirePermission(P.ORG_VIEW),
  controller.listMembers,
);

organizationRoutes.post(
  '/organizations/me/members/invite',
  authenticate,
  requirePermission(P.ORG_MEMBER_MANAGE),
  validate({ body: inviteMemberSchema }),
  controller.inviteMember,
);

organizationRoutes.patch(
  '/organizations/me/members/:userId',
  authenticate,
  requirePermission(P.ORG_MEMBER_MANAGE),
  validate({ params: memberParamSchema, body: updateMemberSchema }),
  controller.updateMember,
);

/** Removal is suspension — nothing is hard-deleted. */
organizationRoutes.delete(
  '/organizations/me/members/:userId',
  authenticate,
  requirePermission(P.ORG_MEMBER_MANAGE),
  validate({ params: memberParamSchema }),
  controller.suspendMember,
);
