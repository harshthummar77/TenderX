import { Router } from 'express';
import {
  PERMISSIONS as P,
  reportQuerySchema,
  spendReportQuerySchema,
  tenderReportQuerySchema,
  vendorPerformanceQuerySchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './report.controller.js';

/**
 * Reports (plan 15 §3).
 *
 * All four are `REPORT_VIEW`, which both organization roles hold and `VENDOR`
 * does not: these aggregate across vendors, so a vendor reading them would see
 * their competitors' order values. A vendor's own performance is their
 * scorecard (plan 06) and their dashboard, both of which are filtered to them.
 *
 * Every report takes `?format=csv` and shares one exporter.
 */
export const reportRoutes = Router();

reportRoutes.get(
  '/reports/spend',
  authenticate,
  requirePermission(P.REPORT_VIEW),
  validate({ query: spendReportQuerySchema }),
  controller.spend,
);

reportRoutes.get(
  '/reports/vendor-performance',
  authenticate,
  requirePermission(P.REPORT_VIEW),
  validate({ query: vendorPerformanceQuerySchema }),
  controller.vendorPerformance,
);

reportRoutes.get(
  '/reports/tenders',
  authenticate,
  requirePermission(P.REPORT_VIEW),
  validate({ query: tenderReportQuerySchema }),
  controller.tenders,
);

/** The internal-audit artefact: what failed the match, and who overrode it. */
reportRoutes.get(
  '/reports/match-exceptions',
  authenticate,
  requirePermission(P.REPORT_VIEW),
  validate({ query: reportQuerySchema }),
  controller.matchExceptions,
);
