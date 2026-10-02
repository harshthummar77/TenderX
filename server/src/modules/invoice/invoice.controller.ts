import type { Request, RequestHandler } from 'express';
import type { InvoiceQuery } from '@tb/shared';
import { InvoicePdf } from '../../lib/pdf/InvoicePdf.js';
import { renderPdf } from '../../lib/pdf/renderer.js';
import { prisma } from '../../lib/prisma.js';
import { created, ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { toPurchaseOrderDto } from '../purchase-order/po.serializers.js';
import * as ageing from './ageing.service.js';
import { toInvoiceDto } from './invoice.serializers.js';
import * as service from './invoice.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const listFor =
  (side: 'buyer' | 'vendor'): RequestHandler =>
  async (req, res) => {
    const query = validatedQuery<InvoiceQuery>(req);
    const { rows, total, page, limit } = await service.listInvoices(requireActor(req), query, side);
    paginated(res, rows.map((row) => toInvoiceDto(row)), { page, limit, total });
  };

export const list = listFor('buyer');
export const listMine = listFor('vendor');

export const detail: RequestHandler = async (req, res) => {
  ok(res, toInvoiceDto(await service.loadInvoice(requireActor(req), req.params.id as string)));
};

/* ------------------------------------------------------------------ vendor */

export const invoiceable: RequestHandler = async (req, res) => {
  ok(res, await service.getInvoiceable(requireActor(req), req.params.poId as string));
};

export const create: RequestHandler = async (req, res) => {
  const invoice = await service.createInvoice(
    requireActor(req),
    req.params.poId as string,
    req.body,
    ctxOf(req),
  );
  created(res, toInvoiceDto(invoice));
};

export const update: RequestHandler = async (req, res) => {
  const invoice = await service.updateInvoice(
    requireActor(req),
    req.params.id as string,
    req.body,
    ctxOf(req),
  );
  ok(res, toInvoiceDto(invoice));
};

export const submit: RequestHandler = async (req, res) => {
  const invoice = await service.submitInvoice(
    requireActor(req),
    req.params.id as string,
    ctxOf(req),
  );
  ok(res, toInvoiceDto(invoice));
};

/* ------------------------------------------------------------------- buyer */

export const rematch: RequestHandler = async (req, res) => {
  const { invoice } = await service.rematchInvoice(
    requireActor(req),
    req.params.id as string,
    ctxOf(req),
  );
  ok(res, toInvoiceDto(invoice));
};

export const approve: RequestHandler = async (req, res) => {
  const invoice = await service.approveInvoice(
    requireActor(req),
    req.params.id as string,
    req.body?.comment,
    ctxOf(req),
  );
  ok(res, toInvoiceDto(invoice));
};

export const reject: RequestHandler = async (req, res) => {
  const invoice = await service.rejectInvoice(
    requireActor(req),
    req.params.id as string,
    req.body.reason,
    ctxOf(req),
  );
  ok(res, toInvoiceDto(invoice));
};

export const override: RequestHandler = async (req, res) => {
  const invoice = await service.overrideMatch(
    requireActor(req),
    req.params.id as string,
    req.body.reason,
    ctxOf(req),
  );
  ok(res, toInvoiceDto(invoice));
};

export const ageingReport: RequestHandler = async (req, res) => {
  ok(res, await ageing.getAgeing(requireActor(req)));
};

export const matchExceptions: RequestHandler = async (req, res) => {
  ok(res, await ageing.getMatchExceptions(requireActor(req)));
};

/**
 * Rendered on demand, like the purchase order PDF. Plan 14 owns stored
 * documents; a `storageKey` pointing nowhere would be worse than re-rendering,
 * and every figure on the invoice is frozen on the row.
 */
export const pdf: RequestHandler = async (req, res) => {
  const invoice = await service.loadInvoice(requireActor(req), req.params.id as string);
  const po = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: invoice.purchaseOrderId },
    include: { items: { orderBy: { srNo: 'asc' } } },
  });

  const buffer = await renderPdf(
    InvoicePdf({ invoice: toInvoiceDto(invoice), po: toPurchaseOrderDto(po) }),
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${invoice.referenceNumber.replace(/[^\w.-]/g, '-')}.pdf"`,
  );
  res.send(buffer);
};
