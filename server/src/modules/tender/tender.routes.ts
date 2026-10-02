import { Router } from 'express';
import {
  createTenderSchema,
  declineTenderSchema,
  idParamSchema,
  inviteVendorsSchema,
  PERMISSIONS as P,
  reasonSchema,
  tenderQuerySchema,
  tenderVendorParamSchema,
  updateTenderSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireActiveOrg } from '../../middleware/requireActiveOrg.js';
import { requireApprovedVendor } from '../../middleware/requireApprovedVendor.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './tender.controller.js';

export const tenderRoutes = Router();

/**
 * The first module to carry `requireActiveOrg` (plan 05 §1): a pending or
 * suspended organization can edit its profile, but it cannot put work into the
 * market. Vendor routes carry `requireApprovedVendor` for the same reason on
 * the other side — responding to an invitation is new business.
 */

/* ------------------------------------------------------------------- buyer */

tenderRoutes.get(
  '/tenders',
  authenticate,
  requirePermission(P.TENDER_VIEW),
  validate({ query: tenderQuerySchema }),
  controller.list,
);

tenderRoutes.post(
  '/tenders',
  authenticate,
  requireActiveOrg,
  requirePermission(P.TENDER_CREATE),
  validate({ body: createTenderSchema }),
  controller.create,
);

tenderRoutes.get(
  '/tenders/:id',
  authenticate,
  requirePermission(P.TENDER_VIEW),
  validate({ params: idParamSchema }),
  controller.detail,
);

tenderRoutes.patch(
  '/tenders/:id',
  authenticate,
  requireActiveOrg,
  requirePermission(P.TENDER_UPDATE),
  validate({ params: idParamSchema, body: updateTenderSchema }),
  controller.update,
);

/** The one hard delete in the system — a draft has no counterparties. */
tenderRoutes.delete(
  '/tenders/:id',
  authenticate,
  requireActiveOrg,
  requirePermission(P.TENDER_UPDATE),
  validate({ params: idParamSchema }),
  controller.remove,
);

tenderRoutes.post(
  '/tenders/:id/publish',
  authenticate,
  requireActiveOrg,
  requirePermission(P.TENDER_PUBLISH),
  validate({ params: idParamSchema }),
  controller.publish,
);

tenderRoutes.post(
  '/tenders/:id/cancel',
  authenticate,
  requireActiveOrg,
  requirePermission(P.TENDER_CANCEL),
  validate({ params: idParamSchema, body: reasonSchema }),
  controller.cancel,
);

tenderRoutes.post(
  '/tenders/:id/close-bidding',
  authenticate,
  requireActiveOrg,
  requirePermission(P.TENDER_PUBLISH),
  validate({ params: idParamSchema }),
  controller.closeBidding,
);

tenderRoutes.get(
  '/tenders/:id/suggested-vendors',
  authenticate,
  requirePermission(P.TENDER_VIEW),
  validate({ params: idParamSchema }),
  controller.suggestedVendors,
);

tenderRoutes.get(
  '/tenders/:id/invitations',
  authenticate,
  requirePermission(P.TENDER_VIEW),
  validate({ params: idParamSchema }),
  controller.listInvitations,
);

tenderRoutes.post(
  '/tenders/:id/invitations',
  authenticate,
  requireActiveOrg,
  requirePermission(P.TENDER_PUBLISH),
  validate({ params: idParamSchema, body: inviteVendorsSchema }),
  controller.invite,
);

tenderRoutes.delete(
  '/tenders/:id/invitations/:vendorId',
  authenticate,
  requireActiveOrg,
  requirePermission(P.TENDER_PUBLISH),
  validate({ params: tenderVendorParamSchema }),
  controller.uninvite,
);

/**
 * `/tenders/:id/bid-summary` lives in the quotation module (plan 08): it reads
 * bids, so it belongs with the code that owns the seal.
 */

/* ------------------------------------------------------------------ vendor */

tenderRoutes.get(
  '/vendor/tenders',
  authenticate,
  requirePermission(P.TENDER_VIEW),
  validate({ query: tenderQuerySchema }),
  controller.vendorList,
);

tenderRoutes.get(
  '/vendor/tenders/:id',
  authenticate,
  requirePermission(P.TENDER_VIEW),
  validate({ params: idParamSchema }),
  controller.vendorDetail,
);

tenderRoutes.post(
  '/vendor/tenders/:id/decline',
  authenticate,
  requireApprovedVendor,
  requirePermission(P.TENDER_VIEW),
  validate({ params: idParamSchema, body: declineTenderSchema }),
  controller.decline,
);
