import type { PaymentDto } from '@tb/shared';
import { numberToIndianWords } from '@tb/shared';
import { money, toApi } from '../../lib/money.js';
import type { PaymentWithRelations } from './payment.service.js';

/**
 * One shape for both sides. A vendor is entitled to every figure on a payment
 * against them — above all the TDS amount and section, which they need to
 * reconcile their own Form 26AS.
 */
export function toPaymentDto(payment: PaymentWithRelations): PaymentDto {
  const net = toApi(payment.netAmount);
  const invoice = payment.invoice;

  return {
    id: payment.id,
    paymentNumber: payment.paymentNumber,
    status: payment.status,
    invoiceId: payment.invoiceId,
    invoiceReference: invoice?.referenceNumber ?? null,
    vendorInvoiceNumber: invoice?.vendorInvoiceNumber ?? null,
    poNumber: invoice?.purchaseOrder?.poNumber ?? null,
    vendorId: payment.vendorId,
    vendorName: null,
    grossAmount: toApi(payment.grossAmount),
    tdsAmount: toApi(payment.tdsAmount),
    tdsSection: payment.tdsSection,
    retentionAmount: toApi(payment.retentionAmount),
    otherDeduction: toApi(payment.otherDeduction),
    netAmount: net,
    // The words track netAmount, not gross: this is what the bank paid.
    netAmountInWords: numberToIndianWords(net),
    method: payment.method,
    referenceNumber: payment.referenceNumber,
    paidAt: payment.paidAt.toISOString(),
    valueDate: payment.valueDate?.toISOString() ?? null,
    recordedById: payment.recordedById,
    approvedById: payment.approvedById,
    approvedAt: payment.approvedAt?.toISOString() ?? null,
    remarks: payment.remarks,
    failureReason: payment.failureReason,
    invoiceOutstanding: invoice
      ? toApi(money(invoice.totalAmount).minus(money(invoice.amountPaid)))
      : null,
    createdAt: payment.createdAt.toISOString(),
  };
}
