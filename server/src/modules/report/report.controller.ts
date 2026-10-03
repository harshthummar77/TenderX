import type { Request, RequestHandler } from 'express';
import type {
  ReportQuery,
  ReportResponse,
  SpendReportQuery,
  TenderReportQuery,
  VendorPerformanceQuery,
} from '@tb/shared';
import { ok } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { reportFileName, reportToCsv } from './csv.js';
import { matchExceptionReport } from './matchException.report.js';
import { spendReport } from './spend.report.js';
import { tenderReport } from './tender.report.js';
import { vendorPerformanceReport } from './vendorPerformance.report.js';

/**
 * Every report answers on the same contract, so one helper serves all four: JSON
 * in the usual envelope, or the same data as a CSV attachment.
 */
function respond(req: Request, res: Parameters<RequestHandler>[1], report: ReportResponse): void {
  const format = (req.query.format as string | undefined) ?? 'json';

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(report)}"`);
    res.send(reportToCsv(report));
    return;
  }

  ok(res, report);
}

export const spend: RequestHandler = async (req, res) => {
  const report = await spendReport(requireActor(req), validatedQuery<SpendReportQuery>(req));
  respond(req, res, report);
};

export const vendorPerformance: RequestHandler = async (req, res) => {
  const report = await vendorPerformanceReport(
    requireActor(req),
    validatedQuery<VendorPerformanceQuery>(req),
  );
  respond(req, res, report);
};

export const tenders: RequestHandler = async (req, res) => {
  const report = await tenderReport(requireActor(req), validatedQuery<TenderReportQuery>(req));
  respond(req, res, report);
};

export const matchExceptions: RequestHandler = async (req, res) => {
  const report = await matchExceptionReport(requireActor(req), validatedQuery<ReportQuery>(req));
  respond(req, res, report);
};
