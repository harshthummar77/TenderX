import type { PurchaseOrder, PurchaseOrderItem } from '@prisma/client';
import type { PoItemDto, PoPartyDto, PurchaseOrderDto } from '@tb/shared';
import { STATE_BY_CODE, numberToIndianWords } from '@tb/shared';
import { qtyToApi, toApi } from '../../lib/money.js';
import { taxHeadsFor } from '../../lib/tax.js';

export type PoWithItems = PurchaseOrder & { items: PurchaseOrderItem[] };

const stateNameOf = (code: string): string | null => STATE_BY_CODE.get(code)?.name ?? null;

const toItemDto = (item: PurchaseOrderItem): PoItemDto => ({
  id: item.id,
  srNo: item.srNo,
  tenderItemId: item.tenderItemId,
  description: item.description,
  hsnCode: item.hsnCode,
  unit: item.unit,
  quantity: qtyToApi(item.quantity),
  unitPrice: toApi(item.unitPrice),
  discountPercent: item.discountPercent.toFixed(2),
  taxableValue: toApi(item.taxableValue),
  taxRatePercent: item.taxRatePercent.toFixed(2),
  cgstAmount: toApi(item.cgstAmount),
  sgstAmount: toApi(item.sgstAmount),
  igstAmount: toApi(item.igstAmount),
  lineTotal: toApi(item.lineTotal),
  receivedQuantity: qtyToApi(item.receivedQuantity),
  acceptedQuantity: qtyToApi(item.acceptedQuantity),
  invoicedQuantity: qtyToApi(item.invoicedQuantity),
});

/**
 * The frozen party snapshot, read straight off the purchase order row.
 *
 * **Never from the live Vendor or Organization row** (10 §2). A purchase order
 * is a contract: if the vendor moves office next month, the order issued today
 * must still show the address it was issued to — and above all the state code
 * that determined its tax regime. Re-deriving either would silently rewrite
 * history.
 */
const buyerOf = (po: PurchaseOrder): PoPartyDto => ({
  name: po.buyerName,
  gstin: po.buyerGstin,
  address: po.buyerAddress,
  stateCode: po.buyerStateCode,
  stateName: stateNameOf(po.buyerStateCode),
});

const vendorOf = (po: PurchaseOrder): PoPartyDto => ({
  name: po.vendorName,
  gstin: po.vendorGstin,
  address: po.vendorAddress,
  stateCode: po.vendorStateCode,
  stateName: stateNameOf(po.vendorStateCode),
});

/**
 * One DTO for both sides. Unlike a tender or a quotation there is nothing to
 * hide here: the purchase order is a document both parties signed, and the
 * vendor knows every figure on it because they quoted them.
 */
export function toPurchaseOrderDto(
  po: PoWithItems,
  options: { awaitingResponse?: boolean } = {},
): PurchaseOrderDto {
  const totalAmount = toApi(po.totalAmount);

  return {
    id: po.id,
    poNumber: po.poNumber,
    status: po.status,
    fulfilmentStatus: po.fulfilmentStatus,
    tenderId: po.tenderId,
    quotationId: po.quotationId,
    vendorId: po.vendorId,
    buyer: buyerOf(po),
    vendor: vendorOf(po),
    placeOfSupplyStateCode: po.placeOfSupplyStateCode,
    placeOfSupplyStateName: stateNameOf(po.placeOfSupplyStateCode),
    taxRegime: po.taxRegime,
    taxHeads: taxHeadsFor(po.taxRegime),
    subtotal: toApi(po.subtotal),
    discountAmount: toApi(po.discountAmount),
    taxableAmount: toApi(po.taxableAmount),
    cgstAmount: toApi(po.cgstAmount),
    sgstAmount: toApi(po.sgstAmount),
    igstAmount: toApi(po.igstAmount),
    freightAmount: toApi(po.freightAmount),
    roundOff: toApi(po.roundOff),
    totalAmount,
    // Derived from the same string the API emits, so the words and the figure
    // can never disagree on the document.
    totalAmountInWords: numberToIndianWords(totalAmount),
    currency: po.currency,
    expectedDeliveryDate: po.expectedDeliveryDate.toISOString(),
    deliveryAddress: po.deliveryAddress,
    paymentTerms: po.paymentTerms,
    termsAndConditions: po.termsAndConditions,
    items: [...po.items].sort((a, b) => a.srNo - b.srNo).map(toItemDto),
    issuedAt: po.issuedAt?.toISOString() ?? null,
    acceptedAt: po.acceptedAt?.toISOString() ?? null,
    rejectedAt: po.rejectedAt?.toISOString() ?? null,
    rejectionReason: po.rejectionReason,
    cancelledAt: po.cancelledAt?.toISOString() ?? null,
    cancellationReason: po.cancellationReason,
    closedAt: po.closedAt?.toISOString() ?? null,
    awaitingResponse: options.awaitingResponse ?? false,
    createdAt: po.createdAt.toISOString(),
  };
}

/**
 * Has the vendor been sitting on this longer than the response window?
 *
 * Reported, never acted on automatically (10 §5): an unanswered order is not
 * cancelled, it is flagged, and the buyer decides.
 */
export const isAwaitingResponse = (
  po: Pick<PurchaseOrder, 'status' | 'issuedAt'>,
  expectedResponseDays: number,
  now: Date = new Date(),
): boolean => {
  if (po.status !== 'ISSUED' || !po.issuedAt) return false;
  return now.getTime() - po.issuedAt.getTime() > expectedResponseDays * 86_400_000;
};
