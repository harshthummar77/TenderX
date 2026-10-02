import type { Request, RequestHandler } from 'express';
import type { PoQuery } from '@tb/shared';
import { PurchaseOrderPdf } from '../../lib/pdf/PurchaseOrderPdf.js';
import { renderPdf } from '../../lib/pdf/renderer.js';
import { created, ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { isAwaitingResponse, toPurchaseOrderDto } from './po.serializers.js';
import * as service from './po.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

/**
 * One DTO builder for both sides. A purchase order is a document both parties
 * signed, so unlike a tender or a sealed bid there is nothing to withhold —
 * the vendor quoted every figure on it.
 */
const dtoOf = async (po: Awaited<ReturnType<typeof service.loadPo>>) =>
  toPurchaseOrderDto(po, {
    awaitingResponse: isAwaitingResponse(po, await service.responseWindowFor(po.organizationId)),
  });

const listFor =
  (side: 'buyer' | 'vendor'): RequestHandler =>
  async (req, res) => {
    const query = validatedQuery<PoQuery>(req);
    const { rows, total, page, limit } = await service.listPos(requireActor(req), query, side);
    paginated(res, await Promise.all(rows.map((po) => dtoOf(po))), { page, limit, total });
  };

export const list = listFor('buyer');
export const listMine = listFor('vendor');

export const detail: RequestHandler = async (req, res) => {
  ok(res, await dtoOf(await service.loadPo(requireActor(req), req.params.id as string)));
};

export const fulfilment: RequestHandler = async (req, res) => {
  ok(res, await service.getFulfilment(requireActor(req), req.params.id as string));
};

/**
 * The PDF is rendered on demand rather than served from storage. Plan 14 owns
 * document storage (Cloudinary + the `Document` table); until it lands, holding
 * a `storageKey` that points nowhere would be worse than rendering again — and
 * rendering is deterministic, because every figure is frozen on the row.
 */
export const pdf: RequestHandler = async (req, res) => {
  const po = await service.loadPo(requireActor(req), req.params.id as string);
  const buffer = await renderPdf(PurchaseOrderPdf({ po: await dtoOf(po) }));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${po.poNumber.replace(/[^\w.-]/g, '-')}.pdf"`);
  res.send(buffer);
};

/* ------------------------------------------------------------------- buyer */

export const issue: RequestHandler = async (req, res) => {
  ok(res, await dtoOf(await service.issuePo(requireActor(req), req.params.id as string, ctxOf(req))));
};

export const amend: RequestHandler = async (req, res) => {
  ok(
    res,
    await dtoOf(
      await service.amendPo(requireActor(req), req.params.id as string, req.body, ctxOf(req)),
    ),
  );
};

export const cancel: RequestHandler = async (req, res) => {
  ok(
    res,
    await dtoOf(
      await service.cancelPo(requireActor(req), req.params.id as string, req.body.reason, ctxOf(req)),
    ),
  );
};

export const createDirect: RequestHandler = async (req, res) => {
  created(res, await dtoOf(await service.createDirectPo(requireActor(req), req.body, ctxOf(req))));
};

/* ------------------------------------------------------------------ vendor */

export const accept: RequestHandler = async (req, res) => {
  ok(
    res,
    await dtoOf(
      await service.acceptPo(requireActor(req), req.params.id as string, req.body?.note, ctxOf(req)),
    ),
  );
};

export const reject: RequestHandler = async (req, res) => {
  ok(
    res,
    await dtoOf(
      await service.rejectPo(requireActor(req), req.params.id as string, req.body.reason, ctxOf(req)),
    ),
  );
};
