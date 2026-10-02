import { Router } from 'express';
import {
  cancelPaymentSchema,
  completePaymentSchema,
  createPaymentSchema,
  failPaymentSchema,
  idParamSchema,
  paymentQuerySchema,
  PERMISSIONS as P,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireActiveOrg } from '../../middleware/requireActiveOrg.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './payment.controller.js';

/**
 * Payments (plan 13 §3).
 *
 * `PAYMENT_RECORD` is `ORG_ADMIN` only and `ORG_OFFICER` deliberately does not
 * hold it (04 §7) — it is on the separation-of-duties list asserted by the test
 * suite. The officer runs the procurement; the admin releases the money. That is
 * the last link in the chain this project exists to demonstrate: one person can
 * never take a purchase from tender to payment alone.
 *
 * `PAYMENT_VIEW` is wider, because an officer chasing a vendor needs to see what
 * has been paid without being able to pay it.
 *
 * Static paths come before `/payments/:id` so `payable` is not read as an id.
 */
export const paymentRoutes = Router();

paymentRoutes.get(
  '/payments',
  authenticate,
  requirePermission(P.PAYMENT_VIEW),
  validate({ query: paymentQuerySchema }),
  controller.list,
);

/** The worklist: approved invoices with their outstanding balance and TDS suggestion. */
paymentRoutes.get(
  '/payments/payable',
  authenticate,
  requirePermission(P.PAYMENT_RECORD),
  controller.payableList,
);

paymentRoutes.post(
  '/payments',
  authenticate,
  requireActiveOrg,
  requirePermission(P.PAYMENT_RECORD),
  validate({ body: createPaymentSchema }),
  controller.record,
);

paymentRoutes.get(
  '/payments/:id',
  authenticate,
  requirePermission(P.PAYMENT_VIEW),
  validate({ params: idParamSchema }),
  controller.detail,
);

/** Where the ledger moves: `Invoice.amountPaid` changes here and nowhere else. */
paymentRoutes.post(
  '/payments/:id/complete',
  authenticate,
  requireActiveOrg,
  requirePermission(P.PAYMENT_RECORD),
  validate({ params: idParamSchema, body: completePaymentSchema }),
  controller.complete,
);

/** The bank returned it. A completed payment is never edited or deleted (§6). */
paymentRoutes.post(
  '/payments/:id/fail',
  authenticate,
  requireActiveOrg,
  requirePermission(P.PAYMENT_RECORD),
  validate({ params: idParamSchema, body: failPaymentSchema }),
  controller.fail,
);

paymentRoutes.post(
  '/payments/:id/cancel',
  authenticate,
  requireActiveOrg,
  requirePermission(P.PAYMENT_RECORD),
  validate({ params: idParamSchema, body: cancelPaymentSchema }),
  controller.cancel,
);

/** The document a vendor needs to reconcile their Form 26AS. */
paymentRoutes.get(
  '/payments/:id/advice',
  authenticate,
  requirePermission(P.PAYMENT_VIEW),
  validate({ params: idParamSchema }),
  controller.advice,
);

paymentRoutes.get(
  '/vendor/payments',
  authenticate,
  requirePermission(P.PAYMENT_VIEW),
  validate({ query: paymentQuerySchema }),
  controller.listMine,
);
