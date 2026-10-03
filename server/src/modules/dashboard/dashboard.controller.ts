import type { RequestHandler } from 'express';
import { ok } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { buildBuyerDashboard } from './buyer.dashboard.js';
import { buildPlatformDashboard } from './platform.dashboard.js';
import { buildVendorDashboard } from './vendor.dashboard.js';

/**
 * One endpoint, dispatching on the actor's role (plan 15 §2).
 *
 * The role decides the whole payload rather than the client asking for a
 * variant: a vendor cannot request the buyer dashboard by changing a query
 * parameter, because there is no parameter to change.
 */
export const dashboard: RequestHandler = async (req, res) => {
  const actor = requireActor(req);

  if (actor.isPlatformAdmin) {
    ok(res, await buildPlatformDashboard());
    return;
  }

  if (actor.role === 'VENDOR') {
    ok(res, await buildVendorDashboard(actor));
    return;
  }

  ok(res, await buildBuyerDashboard(actor));
};
