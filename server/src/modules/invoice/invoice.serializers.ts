import type { Invoice, InvoiceItem, PurchaseOrder, PurchaseOrderItem } from '@prisma/client';
import type { InvoiceDto, InvoiceItemDto, MatchCheckDto } from '@tb/shared';
import { numberToIndianWords } from '@tb/shared';
import { qtyToApi, toApi } from '../../lib/money.js';
import { outstandingOf, payableBlocker } from './payable.js';

export type InvoiceWithRelations = Invoice & {
  items: (InvoiceItem & { purchaseOrderItem?: PurchaseOrderItem | null })[];
  purchaseOrder: PurchaseOrder;
};

const toItemDto = (
  item: InvoiceItem & { purchaseOrderItem?: PurchaseOrderItem | null },
): InvoiceItemDto => ({
  id: item.id,
  purchaseOrderItemId: item.purchaseOrderItemId,
  srNo: item.purchaseOrderItem?.srNo ?? null,
  description: item.description,
  hsnCode: item.hsnCode,
  unit: item.unit,
  quantity: qtyToApi(item.quantity),
  unitPrice: toApi(item.unitPrice),
  taxableValue: toApi(item.taxableValue),
  taxRatePercent: item.taxRatePercent.toFixed(2),
  cgstAmount: toApi(item.cgstAmount),
  sgstAmount: toApi(item.sgstAmount),
  igstAmount: toApi(item.igstAmount),
  lineTotal: toApi(item.lineTotal),
});

/** `matchResult` is a Json column; narrow it once, here. */
const checksOf = (invoice: Invoice): MatchCheckDto[] | null =>
  Array.isArray(invoice.matchResult) ? (invoice.matchResult as unknown as MatchCheckDto[]) : null;

/**
 * One shape for both sides. The vendor sees the full match checklist on purpose:
 * an invoice rejected with no explanation is one the vendor cannot correct, and
 * a correction loop that needs a phone call is not a system.
 */
export function toInvoiceDto(invoice: InvoiceWithRelations, now: Date = new Date()): InvoiceDto {
  const totalAmount = toApi(invoice.totalAmount);
  const overdueMs = now.getTime() - invoice.dueDate.getTime();

  return {
    id: invoice.id,
    referenceNumber: invoice.referenceNumber,
    vendorInvoiceNumber: invoice.vendorInvoiceNumber,
    purchaseOrderId: invoice.purchaseOrderId,
    poNumber: invoice.purchaseOrder?.poNumber ?? null,
    vendorId: invoice.vendorId,
    vendorName: invoice.purchaseOrder?.vendorName ?? null,
    status: invoice.status,
    matchStatus: invoice.matchStatus,
    matchResult: checksOf(invoice),
    matchRunAt: invoice.matchRunAt?.toISOString() ?? null,
    invoiceDate: invoice.invoiceDate.toISOString(),
    dueDate: invoice.dueDate.toISOString(),
    taxRegime: invoice.purchaseOrder?.taxRegime ?? null,
    subtotal: toApi(invoice.subtotal),
    discountAmount: toApi(invoice.discountAmount),
    taxableAmount: toApi(invoice.taxableAmount),
    cgstAmount: toApi(invoice.cgstAmount),
    sgstAmount: toApi(invoice.sgstAmount),
    igstAmount: toApi(invoice.igstAmount),
    freightAmount: toApi(invoice.freightAmount),
    roundOff: toApi(invoice.roundOff),
    totalAmount,
    totalAmountInWords: numberToIndianWords(totalAmount),
    amountPaid: toApi(invoice.amountPaid),
    outstanding: toApi(outstandingOf(invoice)),
    items: [...invoice.items]
      .sort((a, b) => (a.purchaseOrderItem?.srNo ?? 0) - (b.purchaseOrderItem?.srNo ?? 0))
      .map(toItemDto),
    submittedAt: invoice.submittedAt?.toISOString() ?? null,
    approvedById: invoice.approvedById,
    approvedAt: invoice.approvedAt?.toISOString() ?? null,
    rejectionReason: invoice.rejectionReason,
    overriddenById: invoice.overriddenById,
    overrideReason: invoice.overrideReason,
    paidAt: invoice.paidAt?.toISOString() ?? null,
    payableBlocker: payableBlocker(invoice),
    daysOverdue: overdueMs <= 0 ? 0 : Math.floor(overdueMs / 86_400_000),
    createdAt: invoice.createdAt.toISOString(),
  };
}
