import type { Request, RequestHandler } from 'express';
import type { QuotationQuery } from '@tb/shared';
import { created, ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { toQuotationVendorDto } from './quotation.serializers.js';
import * as service from './quotation.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

/* -------------------------------------------------------------------------- */
/* Vendor — always the full picture, it is their own bid                      */
/* -------------------------------------------------------------------------- */

export const listMine: RequestHandler = async (req, res) => {
  const query = validatedQuery<QuotationQuery>(req);
  const { rows, total, page, limit } = await service.listOwnQuotations(requireActor(req), query);
  paginated(res, rows.map(toQuotationVendorDto), { page, limit, total });
};

export const detailMine: RequestHandler = async (req, res) => {
  const quotation = await service.loadOwnQuotation(requireActor(req), req.params.id as string);
  ok(res, toQuotationVendorDto(quotation));
};

/** Create-or-fetch: pressing "Bid now" twice must not create two drafts. */
export const openDraft: RequestHandler = async (req, res) => {
  const quotation = await service.openDraft(
    requireActor(req),
    req.params.tenderId as string,
    ctxOf(req),
  );
  created(res, toQuotationVendorDto(quotation));
};

export const saveDraft: RequestHandler = async (req, res) => {
  const quotation = await service.updateDraft(
    requireActor(req),
    req.params.id as string,
    req.body,
    ctxOf(req),
  );
  ok(res, toQuotationVendorDto(quotation));
};

export const submit: RequestHandler = async (req, res) => {
  const quotation = await service.submitQuotation(
    requireActor(req),
    req.params.id as string,
    ctxOf(req),
  );
  ok(res, toQuotationVendorDto(quotation));
};

export const withdraw: RequestHandler = async (req, res) => {
  const quotation = await service.withdrawQuotation(
    requireActor(req),
    req.params.id as string,
    req.body.reason,
    ctxOf(req),
  );
  ok(res, toQuotationVendorDto(quotation));
};

export const revise: RequestHandler = async (req, res) => {
  const revision = await service.reviseQuotation(
    requireActor(req),
    req.params.id as string,
    ctxOf(req),
  );
  created(res, toQuotationVendorDto(revision));
};

/* -------------------------------------------------------------------------- */
/* Buyer — sealed-aware                                                       */
/* -------------------------------------------------------------------------- */

export const listForTender: RequestHandler = async (req, res) => {
  ok(res, await service.listTenderQuotations(requireActor(req), req.params.id as string));
};

export const detailForBuyer: RequestHandler = async (req, res) => {
  ok(res, await service.getQuotationForBuyer(requireActor(req), req.params.id as string));
};

export const bidSummary: RequestHandler = async (req, res) => {
  ok(res, await service.bidSummary(requireActor(req), req.params.id as string));
};

export const verifySeal: RequestHandler = async (req, res) => {
  ok(res, await service.verifyQuotationSeal(requireActor(req), req.params.id as string));
};
