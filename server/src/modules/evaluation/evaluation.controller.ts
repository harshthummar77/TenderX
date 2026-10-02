import type { Request, RequestHandler } from 'express';
import { ok } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { comparisonFileName, comparisonToCsv } from './export.service.js';
import * as service from './evaluation.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

export const comparison: RequestHandler = async (req, res) => {
  ok(res, await service.getComparison(requireActor(req), req.params.id as string));
};

/**
 * The one endpoint in the system that does not return the JSON envelope: it
 * returns a file. `Content-Disposition` carries the tender reference so an
 * officer who exports three tenders does not end up with three `export.csv`.
 */
export const exportComparison: RequestHandler = async (req, res) => {
  const data = await service.getComparison(requireActor(req), req.params.id as string);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${comparisonFileName(data)}"`);
  res.send(comparisonToCsv(data));
};

export const open: RequestHandler = async (req, res) => {
  ok(res, await service.openEvaluation(requireActor(req), req.params.id as string, ctxOf(req)));
};

export const score: RequestHandler = async (req, res) => {
  ok(
    res,
    await service.scoreQuotation(requireActor(req), req.params.id as string, req.body, ctxOf(req)),
  );
};

export const recalculate: RequestHandler = async (req, res) => {
  ok(res, await service.recalculate(requireActor(req), req.params.id as string, ctxOf(req)));
};

export const recommend: RequestHandler = async (req, res) => {
  ok(
    res,
    await service.recommend(requireActor(req), req.params.id as string, req.body, ctxOf(req)),
  );
};
