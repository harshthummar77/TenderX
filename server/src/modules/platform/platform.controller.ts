import type { Request, RequestHandler } from 'express';
import type { PlatformOrgQuery } from '@tb/shared';
import { ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { completionOf, toPlatformOrgListItem } from '../organization/organization.serializers.js';
import * as service from './platform.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

export const listOrganizations: RequestHandler = async (req, res) => {
  const query = validatedQuery<PlatformOrgQuery>(req);
  const { rows, total, certified, page, limit } = await service.listOrganizations(query);
  paginated(
    res,
    rows.map((org) => toPlatformOrgListItem(org, certified.has(org.id))),
    { page, limit, total },
  );
};

export const getOrganization: RequestHandler = async (req, res) => {
  const { org, documents } = await service.getOrganization(req.params.id as string);
  const hasCertificate = documents.some((doc) => doc.type === 'ORG_GST_CERTIFICATE');

  ok(res, {
    ...toPlatformOrgListItem(org, hasCertificate),
    email: org.email,
    phone: org.phone,
    pan: org.pan,
    addressLine1: org.addressLine1,
    addressLine2: org.addressLine2,
    pincode: org.pincode,
    stateCode: org.stateCode,
    approvedAt: org.approvedAt?.toISOString() ?? null,
    completion: completionOf(org, hasCertificate),
    missingKyc: await service.missingKyc(org),
    documents,
  });
};

export const approve: RequestHandler = async (req, res) => {
  const org = await service.approveOrganization(requireActor(req), req.params.id as string, ctxOf(req));
  ok(res, { id: org.id, status: org.status, approvedAt: org.approvedAt?.toISOString() ?? null });
};

export const reject: RequestHandler = async (req, res) => {
  const result = await service.rejectOrganization(
    requireActor(req),
    req.params.id as string,
    req.body.reason,
    ctxOf(req),
  );
  ok(res, result);
};

export const suspend: RequestHandler = async (req, res) => {
  const org = await service.suspendOrganization(
    requireActor(req),
    req.params.id as string,
    req.body.reason,
    ctxOf(req),
  );
  ok(res, { id: org.id, status: org.status });
};

export const stats: RequestHandler = async (_req, res) => {
  ok(res, await service.platformStats());
};
