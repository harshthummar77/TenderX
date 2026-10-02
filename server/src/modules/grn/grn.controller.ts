import type { Request, RequestHandler } from 'express';
import type { GrnQuery } from '@tb/shared';
import { prisma } from '../../lib/prisma.js';
import { created, ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { toPurchaseOrderDto } from '../purchase-order/po.serializers.js';
import { toGrnDto, type GrnWithRelations } from './grn.serializers.js';
import * as service from './grn.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

/**
 * `Grn.receivedById` is a plain column with no Prisma relation, so the receiving
 * officer's name is resolved separately rather than through an include.
 */
const namesFor = async (grns: GrnWithRelations[]): Promise<Map<string, string>> => {
  const ids = [...new Set(grns.map((grn) => grn.receivedById))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((user) => [user.id, user.fullName]));
};

export const list: RequestHandler = async (req, res) => {
  const query = validatedQuery<GrnQuery>(req);
  const { rows, total, page, limit } = await service.listGrns(requireActor(req), query);
  const names = await namesFor(rows);
  paginated(res, rows.map((row) => toGrnDto(row, names.get(row.receivedById) ?? null)), {
    page,
    limit,
    total,
  });
};

export const detail: RequestHandler = async (req, res) => {
  const grn = await service.loadGrn(requireActor(req), req.params.id as string);
  const names = await namesFor([grn]);
  ok(res, toGrnDto(grn, names.get(grn.receivedById) ?? null));
};

/** The prefilled worklist an officer captures against. */
export const receivable: RequestHandler = async (req, res) => {
  ok(res, await service.getReceivable(requireActor(req), req.params.poId as string));
};

export const create: RequestHandler = async (req, res) => {
  const grn = await service.createGrn(
    requireActor(req),
    req.params.poId as string,
    req.body,
    ctxOf(req),
  );
  const names = await namesFor([grn]);
  created(res, toGrnDto(grn, names.get(grn.receivedById) ?? null));
};

export const shortClose: RequestHandler = async (req, res) => {
  const po = await service.shortClosePo(
    requireActor(req),
    req.params.poId as string,
    req.body.reason,
    ctxOf(req),
  );
  ok(res, toPurchaseOrderDto(po));
};
