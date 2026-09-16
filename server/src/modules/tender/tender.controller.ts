import type { Prisma } from '@prisma/client';
import type { Request, RequestHandler } from 'express';
import type { TenderQuery } from '@tb/shared';
import { NotFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { created, noContent, ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { closeExpired } from './deadline.service.js';
import * as invitations from './invitation.service.js';
import * as service from './tender.service.js';
import { toTenderBuyerDto, toTenderVendorDto } from './tender.serializers.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const buyerDto = async (tender: Awaited<ReturnType<typeof service.loadTender>>) =>
  toTenderBuyerDto(tender, await service.countsFor(tender.id));

/* -------------------------------------------------------------------------- */
/* Buyer                                                                      */
/* -------------------------------------------------------------------------- */

export const list: RequestHandler = async (req, res) => {
  const query = validatedQuery<TenderQuery>(req);
  const { rows, total, page, limit } = await service.listTenders(requireActor(req), query);

  const data = await Promise.all(rows.map((tender) => buyerDto(tender)));
  paginated(res, data, { page, limit, total });
};

export const detail: RequestHandler = async (req, res) => {
  const actor = requireActor(req);
  await closeExpired(actor.organizationId ?? undefined);
  ok(res, await buyerDto(await service.loadTender(actor, req.params.id as string)));
};

export const create: RequestHandler = async (req, res) => {
  const tender = await service.createTender(requireActor(req), req.body, ctxOf(req));
  created(res, await buyerDto(tender));
};

export const update: RequestHandler = async (req, res) => {
  const tender = await service.updateTender(
    requireActor(req),
    req.params.id as string,
    req.body,
    ctxOf(req),
  );
  ok(res, await buyerDto(tender));
};

export const remove: RequestHandler = async (req, res) => {
  await service.deleteDraft(requireActor(req), req.params.id as string, ctxOf(req));
  noContent(res);
};

export const publish: RequestHandler = async (req, res) => {
  const tender = await service.publishTender(requireActor(req), req.params.id as string, ctxOf(req));
  ok(res, await buyerDto(tender));
};

export const cancel: RequestHandler = async (req, res) => {
  const tender = await service.cancelTender(
    requireActor(req),
    req.params.id as string,
    req.body.reason,
    ctxOf(req),
  );
  ok(res, await buyerDto(tender));
};

export const closeBidding: RequestHandler = async (req, res) => {
  const tender = await service.closeBiddingEarly(requireActor(req), req.params.id as string, ctxOf(req));
  ok(res, await buyerDto(tender));
};

export const bidSummary: RequestHandler = async (req, res) => {
  ok(res, await service.bidSummary(requireActor(req), req.params.id as string));
};

/* ------------------------------------------------------------- invitations */

export const listInvitations: RequestHandler = async (req, res) => {
  const actor = requireActor(req);
  await service.loadTender(actor, req.params.id as string); // scope check
  ok(res, await invitations.listInvitations(req.params.id as string));
};

export const invite: RequestHandler = async (req, res) => {
  const rows = await invitations.inviteVendors(
    requireActor(req),
    req.params.id as string,
    req.body.vendorIds,
    ctxOf(req),
  );
  created(res, rows);
};

export const uninvite: RequestHandler = async (req, res) => {
  await invitations.uninviteVendor(
    requireActor(req),
    req.params.id as string,
    req.params.vendorId as string,
    ctxOf(req),
  );
  noContent(res);
};

export const suggestedVendors: RequestHandler = async (req, res) => {
  ok(res, await invitations.suggestedVendors(requireActor(req), req.params.id as string));
};

/* -------------------------------------------------------------------------- */
/* Vendor                                                                     */
/* -------------------------------------------------------------------------- */

/** Invited tenders that are still open, newest first. */
export const vendorList: RequestHandler = async (req, res) => {
  const actor = requireActor(req);
  if (!actor.vendorId) throw NotFound('Vendor');

  await closeExpired();

  const query = validatedQuery<TenderQuery>(req);
  const where: Prisma.TenderWhereInput = {
    invitations: { some: { vendorId: actor.vendorId } },
    // Default view: what a vendor can still act on.
    ...(query.status
      ? { status: query.status }
      : { status: { in: ['PUBLISHED', 'BIDDING_CLOSED'] } }),
  };

  const [rows, total] = await Promise.all([
    prisma.tender.findMany({
      where,
      include: { items: { orderBy: { srNo: 'asc' } }, category: true, organization: true },
      orderBy: { bidSubmissionDeadline: 'asc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.tender.count({ where }),
  ]);

  const data = await Promise.all(
    rows.map(async (tender) =>
      toTenderVendorDto(tender, {
        invitation: await prisma.tenderInvitation.findUnique({
          where: { tenderId_vendorId: { tenderId: tender.id, vendorId: actor.vendorId! } },
        }),
        quotation: await prisma.quotation.findFirst({
          where: { tenderId: tender.id, vendorId: actor.vendorId!, isLatest: true },
          select: { id: true, status: true, submittedAt: true },
        }),
      }),
    ),
  );

  paginated(res, data, { page: query.page, limit: query.limit, total });
};

export const vendorDetail: RequestHandler = async (req, res) => {
  const actor = requireActor(req);
  if (!actor.vendorId) throw NotFound('Tender');
  const tenderId = req.params.id as string;

  await closeExpired();

  // Scoped through the invitation: a tender this vendor was not invited to is a
  // 404, exactly like any other cross-tenant read.
  const tender = await prisma.tender.findFirst({
    where: { id: tenderId, invitations: { some: { vendorId: actor.vendorId } } },
    include: { items: { orderBy: { srNo: 'asc' } }, category: true, organization: true },
  });
  if (!tender) throw NotFound('Tender');

  await invitations.markViewed(actor.vendorId, tenderId);

  ok(
    res,
    toTenderVendorDto(tender, {
      invitation: await prisma.tenderInvitation.findUnique({
        where: { tenderId_vendorId: { tenderId, vendorId: actor.vendorId } },
      }),
      quotation: await prisma.quotation.findFirst({
        where: { tenderId, vendorId: actor.vendorId, isLatest: true },
        select: { id: true, status: true, submittedAt: true },
      }),
    }),
  );
};

export const decline: RequestHandler = async (req, res) => {
  await invitations.declineInvitation(
    requireActor(req),
    req.params.id as string,
    req.body.reason,
    ctxOf(req),
  );
  ok(res, { declined: true });
};
