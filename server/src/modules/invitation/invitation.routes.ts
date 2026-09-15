import { Router } from 'express';
import {
  acceptInvitationSchema,
  createInvitationSchema,
  idParamSchema,
  invitationTokenParamSchema,
  PERMISSIONS as P,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { acceptInviteRateLimit } from '../../middleware/rateLimit.js';
import { requireAnyPermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './invitation.controller.js';

/**
 * Three different roles manage logins for three different things: an org admin
 * manages members, a vendor manages its own company's staff, a platform admin
 * manages the platform. Layer 1 admits any of them; the service's role-grant
 * matrix then decides which role each may actually hand out — an ORG_OFFICER
 * holds none of these and is stopped here.
 */
const canManageLogins = requireAnyPermission(
  P.ORG_MEMBER_MANAGE,
  P.VENDOR_UPDATE_SELF,
  P.PLATFORM_MANAGE,
);

export const invitationRoutes = Router();

// --- public: the invitee has a token, not an account yet ------------------
invitationRoutes.get(
  '/invitations/:token',
  validate({ params: invitationTokenParamSchema }),
  controller.preview,
);

invitationRoutes.post(
  '/invitations/:token/accept',
  acceptInviteRateLimit,
  validate({ params: invitationTokenParamSchema, body: acceptInvitationSchema }),
  controller.accept,
);

// --- authenticated --------------------------------------------------------
invitationRoutes.post(
  '/invitations',
  authenticate,
  canManageLogins,
  validate({ body: createInvitationSchema }),
  controller.create,
);

invitationRoutes.get('/invitations', authenticate, canManageLogins, controller.list);

invitationRoutes.delete(
  '/invitations/:id',
  authenticate,
  canManageLogins,
  validate({ params: idParamSchema }),
  controller.revoke,
);
