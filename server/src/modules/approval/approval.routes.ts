import { Router } from 'express';
import { approvalQuerySchema, decideSchema, idParamSchema, PERMISSIONS as P } from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireActiveOrg } from '../../middleware/requireActiveOrg.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './approval.controller.js';

/**
 * Every route here requires `APPROVAL_DECIDE`, which `ORG_OFFICER` deliberately
 * does not hold (04 §7). So an officer calling `decide` gets a 403 from the
 * permission layer **before any business logic runs** — the separation of
 * duties is enforced twice, by the role matrix and then by `assertCanDecide`,
 * and the two answer different questions:
 *
 *   permission layer — may this ROLE decide at all?        403
 *   assertCanDecide  — may this PERSON decide THIS request?  422
 *
 * The queue is gated the same way: an officer has no business reading the list
 * of decisions they cannot make.
 */
export const approvalRoutes = Router();

approvalRoutes.get(
  '/approvals',
  authenticate,
  requirePermission(P.APPROVAL_DECIDE),
  validate({ query: approvalQuerySchema }),
  controller.list,
);

approvalRoutes.get(
  '/approvals/:id',
  authenticate,
  requirePermission(P.APPROVAL_DECIDE),
  validate({ params: idParamSchema }),
  controller.detail,
);

approvalRoutes.post(
  '/approvals/:id/decide',
  authenticate,
  requireActiveOrg,
  requirePermission(P.APPROVAL_DECIDE),
  validate({ params: idParamSchema, body: decideSchema }),
  controller.decide,
);
