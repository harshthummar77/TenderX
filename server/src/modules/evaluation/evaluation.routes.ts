import { Router } from 'express';
import {
  idParamSchema,
  PERMISSIONS as P,
  recommendSchema,
  scoreSchema,
  submitQuotationSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requireActiveOrg } from '../../middleware/requireActiveOrg.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './evaluation.controller.js';

/**
 * Evaluation is buyer-side only — there is no vendor route in this file, and
 * there must not be: a vendor who could read the comparison matrix would learn
 * every rival's price.
 *
 * `EVALUATION_RECOMMEND` is separate from `EVALUATION_RUN` so an organization
 * can let a junior officer score bids without letting them nominate a winner.
 */
export const evaluationRoutes = Router();

evaluationRoutes.get(
  '/tenders/:id/comparison',
  authenticate,
  requirePermission(P.EVALUATION_RUN),
  validate({ params: idParamSchema }),
  controller.comparison,
);

/** Registered before the bare `/comparison` path for clarity; Express matches exactly. */
evaluationRoutes.get(
  '/tenders/:id/comparison/export',
  authenticate,
  requirePermission(P.EVALUATION_RUN),
  validate({ params: idParamSchema }),
  controller.exportComparison,
);

evaluationRoutes.post(
  '/tenders/:id/evaluation/open',
  authenticate,
  requireActiveOrg,
  requirePermission(P.EVALUATION_RUN),
  validate({ params: idParamSchema, body: submitQuotationSchema }),
  controller.open,
);

evaluationRoutes.post(
  '/tenders/:id/evaluation/recalculate',
  authenticate,
  requireActiveOrg,
  requirePermission(P.EVALUATION_RUN),
  validate({ params: idParamSchema, body: submitQuotationSchema }),
  controller.recalculate,
);

/** Manual criteria only, 0–10, and an extreme mark costs a sentence. */
evaluationRoutes.patch(
  '/quotations/:id/scores',
  authenticate,
  requireActiveOrg,
  requirePermission(P.EVALUATION_RUN),
  validate({ params: idParamSchema, body: scoreSchema }),
  controller.score,
);

evaluationRoutes.post(
  '/tenders/:id/recommend',
  authenticate,
  requireActiveOrg,
  requirePermission(P.EVALUATION_RECOMMEND),
  validate({ params: idParamSchema, body: recommendSchema }),
  controller.recommend,
);
