import type { RequestHandler } from 'express';
import type { ActivityQuery } from '@tb/shared';
import { ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import * as service from './activity.service.js';

export const list: RequestHandler = async (req, res) => {
  const query = validatedQuery<ActivityQuery>(req);
  const { rows, total, page, limit } = await service.listActivity(requireActor(req), query);
  paginated(res, rows, { page, limit, total });
};

/** The actor's own trail. Needs no permission: these are their own actions. */
export const mine: RequestHandler = async (req, res) => {
  const query = validatedQuery<ActivityQuery>(req);
  const { rows, total, page, limit } = await service.listOwnActivity(requireActor(req), query);
  paginated(res, rows, { page, limit, total });
};

/**
 * Chain verification. Safe to run live on stage — it is a read that recomputes
 * every hash and names the first row that does not reproduce.
 */
export const verify: RequestHandler = async (_req, res) => {
  ok(res, await service.verifyChain());
};
