import type { Request, RequestHandler } from 'express';
import type { DeliveryQuery } from '@tb/shared';
import { prisma } from '../../lib/prisma.js';
import { created, ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { toDeliveryDto } from '../grn/grn.serializers.js';
import * as service from './delivery.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const dtoOf = async (delivery: Awaited<ReturnType<typeof service.loadDelivery>>) =>
  toDeliveryDto(delivery, {
    fullyReceipted: await service.isFullyReceipted(prisma, delivery.id),
  });

export const listMine: RequestHandler = async (req, res) => {
  const query = validatedQuery<DeliveryQuery>(req);
  const { rows, total, page, limit } = await service.listOwnDeliveries(requireActor(req), query);
  paginated(res, await Promise.all(rows.map((row) => dtoOf(row))), { page, limit, total });
};

/** Buyer or vendor: both parties have a stake in a challan. */
export const detail: RequestHandler = async (req, res) => {
  ok(res, await dtoOf(await service.loadDelivery(requireActor(req), req.params.id as string)));
};

export const create: RequestHandler = async (req, res) => {
  const delivery = await service.createDelivery(
    requireActor(req),
    req.params.poId as string,
    req.body,
    ctxOf(req),
  );
  created(res, await dtoOf(delivery));
};

export const update: RequestHandler = async (req, res) => {
  const delivery = await service.updateDelivery(
    requireActor(req),
    req.params.id as string,
    req.body,
    ctxOf(req),
  );
  ok(res, await dtoOf(delivery));
};

export const cancel: RequestHandler = async (req, res) => {
  const delivery = await service.cancelDelivery(
    requireActor(req),
    req.params.id as string,
    req.body.reason,
    ctxOf(req),
  );
  ok(res, await dtoOf(delivery));
};
