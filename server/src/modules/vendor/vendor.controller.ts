import type { Request, RequestHandler } from 'express';
import type { VendorQuery } from '@tb/shared';
import { prisma } from '../../lib/prisma.js';
import { created, ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { buildScorecard } from './scorecard.service.js';
import * as service from './vendor.service.js';
import { toVendorAdminDto, toVendorPublicDto, toVendorSelfDto } from './vendor.serializers.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

/* ------------------------------------------------------------ self-service */

export const getOwnVendor: RequestHandler = async (req, res) => {
  ok(res, toVendorSelfDto(await service.loadOwnVendor(requireActor(req))));
};

export const updateOwnVendor: RequestHandler = async (req, res) => {
  const vendor = await service.updateOwnVendor(requireActor(req), req.body, ctxOf(req));
  ok(res, toVendorSelfDto(vendor));
};

export const setOwnCategories: RequestHandler = async (req, res) => {
  const vendor = await service.setOwnCategories(requireActor(req), req.body.categoryIds, ctxOf(req));
  ok(res, toVendorSelfDto(vendor));
};

export const getOwnScorecard: RequestHandler = async (req, res) => {
  const actor = requireActor(req);
  ok(res, await buildScorecard((await service.loadOwnVendor(actor)).id));
};

/* -------------------------------------------------------------- buyer side */

export const listVendors: RequestHandler = async (req, res) => {
  const query = validatedQuery<VendorQuery>(req);
  const { rows, total, page, limit } = await service.listVendors(query);
  paginated(res, rows.map(toVendorPublicDto), { page, limit, total });
};

export const getVendor: RequestHandler = async (req, res) => {
  ok(res, toVendorPublicDto(await service.loadVendor(req.params.id as string)));
};

export const getScorecard: RequestHandler = async (req, res) => {
  ok(res, await buildScorecard(req.params.id as string));
};

export const createVendor: RequestHandler = async (req, res) => {
  const actor = requireActor(req);
  const vendor = await service.createVendor(actor, req.body, ctxOf(req));

  // Invite the contact so the vendor can complete its own KYC.
  await service.inviteVendorContact(actor, vendor.id, vendor.email, req.body.contactName, ctxOf(req));

  created(res, toVendorPublicDto(vendor));
};

/* ---------------------------------------------------------- platform admin */

export const listPlatformVendors: RequestHandler = async (req, res) => {
  const query = validatedQuery<VendorQuery>(req);
  const { rows, total, page, limit } = await service.listVendors(query);
  paginated(res, rows.map(toVendorPublicDto), { page, limit, total });
};

export const getPlatformVendor: RequestHandler = async (req, res) => {
  const vendor = await service.loadVendor(req.params.id as string);

  const [missingKyc, duplicateWarnings, documents, userCount] = await Promise.all([
    service.missingKyc(vendor),
    service.duplicateWarnings(vendor),
    prisma.document.findMany({
      where: { vendorId: vendor.id },
      select: { id: true, type: true, fileName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where: { vendorId: vendor.id } }),
  ]);

  ok(res, toVendorAdminDto(vendor, { missingKyc, duplicateWarnings, documents, userCount }));
};

const transition = (action: 'approve' | 'reject' | 'suspend' | 'reinstate' | 'blacklist'): RequestHandler =>
  async function transitionHandler(req, res) {
    const vendor = await service.changeVendorStatus(
      requireActor(req),
      req.params.id as string,
      action,
      req.body?.reason ?? null,
      ctxOf(req),
    );
    ok(res, { id: vendor.id, status: vendor.status, statusReason: vendor.statusReason });
  };

export const approve = transition('approve');
export const reject = transition('reject');
export const suspend = transition('suspend');
export const reinstate = transition('reinstate');
export const blacklist = transition('blacklist');

/* -------------------------------------------------------------- categories */

export const listCategories: RequestHandler = async (_req, res) => {
  ok(res, await service.listCategories());
};

export const createCategory: RequestHandler = async (req, res) => {
  created(res, await service.createCategory(requireActor(req), req.body));
};
