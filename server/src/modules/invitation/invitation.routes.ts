import { Router } from 'express';
import {
  acceptInvitationSchema,
  createInvitationSchema,
  idParamSchema,
  invitationTokenParamSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { acceptInviteRateLimit } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './invitation.controller.js';

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
  validate({ body: createInvitationSchema }),
  controller.create,
);

invitationRoutes.get('/invitations', authenticate, controller.list);

invitationRoutes.delete(
  '/invitations/:id',
  authenticate,
  validate({ params: idParamSchema }),
  controller.revoke,
);
