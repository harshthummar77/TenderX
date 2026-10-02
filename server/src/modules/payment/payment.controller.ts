import type { Request, RequestHandler } from 'express';
import type { PaymentQuery } from '@tb/shared';
import { PaymentAdvicePdf } from '../../lib/pdf/PaymentAdvicePdf.js';
import { renderPdf } from '../../lib/pdf/renderer.js';
import { prisma } from '../../lib/prisma.js';
import { created, ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import { toPurchaseOrderDto } from '../purchase-order/po.serializers.js';
import * as payable from './payable.service.js';
import { toPaymentDto } from './payment.serializers.js';
import * as service from './payment.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const listFor =
  (side: 'buyer' | 'vendor'): RequestHandler =>
  async (req, res) => {
    const query = validatedQuery<PaymentQuery>(req);
    const { rows, total, page, limit } = await service.listPayments(requireActor(req), query, side);
    paginated(res, rows.map(toPaymentDto), { page, limit, total });
  };

export const list = listFor('buyer');
export const listMine = listFor('vendor');

export const detail: RequestHandler = async (req, res) => {
  ok(res, toPaymentDto(await service.loadPayment(requireActor(req), req.params.id as string)));
};

/** The worklist an accounts person lives on. */
export const payableList: RequestHandler = async (req, res) => {
  ok(res, await payable.getPayable(requireActor(req)));
};

export const record: RequestHandler = async (req, res) => {
  created(res, toPaymentDto(await service.recordPayment(requireActor(req), req.body, ctxOf(req))));
};

export const complete: RequestHandler = async (req, res) => {
  ok(
    res,
    toPaymentDto(
      await service.completePayment(requireActor(req), req.params.id as string, req.body, ctxOf(req)),
    ),
  );
};

export const fail: RequestHandler = async (req, res) => {
  ok(
    res,
    toPaymentDto(
      await service.failPayment(requireActor(req), req.params.id as string, req.body.reason, ctxOf(req)),
    ),
  );
};

export const cancel: RequestHandler = async (req, res) => {
  ok(
    res,
    toPaymentDto(
      await service.cancelPayment(requireActor(req), req.params.id as string, req.body.reason, ctxOf(req)),
    ),
  );
};

/**
 * The payment advice a vendor needs to reconcile their Form 26AS. Rendered on
 * demand, like the other documents; plan 14 owns stored files.
 */
export const advice: RequestHandler = async (req, res) => {
  const payment = await service.loadPayment(requireActor(req), req.params.id as string);
  const po = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: payment.invoice.purchaseOrderId },
    include: { items: { orderBy: { srNo: 'asc' } } },
  });

  const buffer = await renderPdf(
    PaymentAdvicePdf({
      payment: toPaymentDto(payment),
      po: toPurchaseOrderDto(po),
      invoice: {
        referenceNumber: payment.invoice.referenceNumber,
        vendorInvoiceNumber: payment.invoice.vendorInvoiceNumber,
        invoiceDate: payment.invoice.invoiceDate.toISOString(),
        totalAmount: payment.invoice.totalAmount.toFixed(2),
        amountPaid: payment.invoice.amountPaid.toFixed(2),
      },
    }),
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${payment.paymentNumber.replace(/[^\w.-]/g, '-')}-advice.pdf"`,
  );
  res.send(buffer);
};
