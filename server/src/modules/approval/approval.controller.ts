import type { Request, RequestHandler } from 'express';
import type { ApprovalQuery } from '@tb/shared';
import { ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import * as service from './approval.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

export const list: RequestHandler = async (req, res) => {
  const query = validatedQuery<ApprovalQuery>(req);
  const { rows, total, page, limit } = await service.listApprovals(requireActor(req), query);
  paginated(res, rows, { page, limit, total });
};

export const detail: RequestHandler = async (req, res) => {
  ok(res, await service.getApproval(requireActor(req), req.params.id as string));
};

export const decide: RequestHandler = async (req, res) => {
  ok(
    res,
    await service.decideApproval(requireActor(req), req.params.id as string, req.body, ctxOf(req)),
  );
};
