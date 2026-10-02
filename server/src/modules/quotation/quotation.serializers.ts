import type { Quotation, QuotationItem, Tender, TenderItem, Vendor } from '@prisma/client';
import type {
  QuotationBuyerDto,
  QuotationItemDto,
  QuotationSealedDto,
  QuotationVendorDto,
} from '@tb/shared';
import { qtyToApi, toApi } from '../../lib/money.js';
import { isSealed } from './sealing.js';

/**
 * Layer 1 of the two sealing layers (08 §1).
 *
 * `toQuotationBuyerDto` branches on sealed state and the sealed branch **has no
 * access path to a money field**. That is the point: it is not a filter over a
 * full object that somebody can misconfigure by adding a field to the wrong
 * list — the amounts are simply not in scope on that side of the `if`.
 *
 * Layer 2 is the query (`sealedBuyerSelect` below): while sealed, the buyer's
 * list and detail reads use an explicit `select` that never names a money
 * column, so the numbers do not leave Postgres at all.
 *
 * A vendor's own bid is never sealed *from the vendor*. Sealing is about what
 * the buyer may see before the deadline, not about hiding a vendor's own price
 * from themselves.
 */

export type QuotationWithRelations = Quotation & {
  items: (QuotationItem & { tenderItem?: TenderItem | null })[];
  vendor: Vendor;
  tender?: Tender;
};

/**
 * The buyer-side `select` for a sealed tender. Adding a money column here is a
 * leak, and it is one line in a diff — which is exactly why it is written out
 * rather than derived.
 */
export const sealedBuyerSelect = {
  id: true,
  referenceNumber: true,
  status: true,
  submittedAt: true,
  sealHash: true,
  vendor: { select: { id: true, companyName: true, rating: true } },
  _count: { select: { items: true } },
} as const;

export interface SealedBuyerRow {
  id: string;
  referenceNumber: string;
  status: string;
  submittedAt: Date | null;
  sealHash: string | null;
  vendor: { id: string; companyName: string; rating: unknown };
  _count: { items: number };
}

/** The only shape a sealed tender's bids take on the buyer side. */
export const toSealedQuotationDto = (row: SealedBuyerRow): QuotationSealedDto => ({
  id: row.id,
  referenceNumber: row.referenceNumber || null,
  status: row.status,
  vendor: {
    id: row.vendor.id,
    companyName: row.vendor.companyName,
    rating: row.vendor.rating === null ? null : String(row.vendor.rating),
  },
  submittedAt: row.submittedAt?.toISOString() ?? null,
  itemCount: row._count.items,
  sealed: true,
  sealHash: row.sealHash,
});

export const toQuotationItemDto = (
  item: QuotationItem & { tenderItem?: TenderItem | null },
): QuotationItemDto => ({
  id: item.id,
  tenderItemId: item.tenderItemId,
  srNo: item.tenderItem?.srNo ?? null,
  description: item.tenderItem?.description ?? null,
  unit: item.tenderItem?.unit ?? null,
  quantity: qtyToApi(item.quantity),
  unitPrice: toApi(item.unitPrice),
  discountPercent: item.discountPercent.toFixed(2),
  taxableValue: toApi(item.taxableValue),
  taxRatePercent: item.taxRatePercent.toFixed(2),
  taxAmount: toApi(item.taxAmount),
  lineTotal: toApi(item.lineTotal),
  deliveryDays: item.deliveryDays,
  brandOrMake: item.brandOrMake,
  remarks: item.remarks,
});

/** The vendor's own bid, in full, at every status. */
export const toQuotationVendorDto = (
  quotation: QuotationWithRelations & { tender: Tender },
): QuotationVendorDto => ({
  id: quotation.id,
  referenceNumber: quotation.referenceNumber || null,
  tenderId: quotation.tenderId,
  tenderTitle: quotation.tender.title,
  tenderReferenceNumber: quotation.tender.referenceNumber || null,
  bidSubmissionDeadline: quotation.tender.bidSubmissionDeadline.toISOString(),
  status: quotation.status,
  subtotal: toApi(quotation.subtotal),
  discountAmount: toApi(quotation.discountAmount),
  taxableAmount: toApi(quotation.taxableAmount),
  taxAmount: toApi(quotation.taxAmount),
  freightAmount: toApi(quotation.freightAmount),
  grandTotal: toApi(quotation.grandTotal),
  deliveryDays: quotation.deliveryDays,
  validityDays: quotation.validityDays,
  paymentTerms: quotation.paymentTerms,
  notes: quotation.notes,
  items: quotation.items.map(toQuotationItemDto),
  submittedAt: quotation.submittedAt?.toISOString() ?? null,
  sealHash: quotation.sealHash,
  withdrawnAt: quotation.withdrawnAt?.toISOString() ?? null,
  withdrawalReason: quotation.withdrawalReason,
  revisionNumber: quotation.revisionNumber,
  revisionOfId: quotation.revisionOfId,
  isLatest: quotation.isLatest,
  createdAt: quotation.createdAt.toISOString(),
  updatedAt: quotation.updatedAt.toISOString(),
});

/**
 * The buyer's view. Read the two branches: the first one cannot name a money
 * field, and that is the whole enforcement.
 */
export function toQuotationBuyerDto(
  quotation: QuotationWithRelations,
  tender: Pick<Tender, 'bidOpenedAt'>,
): QuotationBuyerDto {
  const base = {
    id: quotation.id,
    referenceNumber: quotation.referenceNumber || null,
    status: quotation.status,
    vendor: {
      id: quotation.vendor.id,
      companyName: quotation.vendor.companyName,
      rating: quotation.vendor.rating === null ? null : quotation.vendor.rating.toFixed(2),
    },
    submittedAt: quotation.submittedAt?.toISOString() ?? null,
    itemCount: quotation.items.length,
  };

  if (isSealed(tender)) {
    return { ...base, sealed: true, sealHash: quotation.sealHash };
  }

  return {
    ...base,
    sealed: false,
    sealHash: quotation.sealHash,
    subtotal: toApi(quotation.subtotal),
    discountAmount: toApi(quotation.discountAmount),
    taxableAmount: toApi(quotation.taxableAmount),
    taxAmount: toApi(quotation.taxAmount),
    freightAmount: toApi(quotation.freightAmount),
    grandTotal: toApi(quotation.grandTotal),
    deliveryDays: quotation.deliveryDays,
    validityDays: quotation.validityDays,
    paymentTerms: quotation.paymentTerms,
    notes: quotation.notes,
    items: quotation.items.map(toQuotationItemDto),
    priceScore: quotation.priceScore === null ? null : quotation.priceScore.toFixed(2),
    technicalScore: quotation.technicalScore === null ? null : quotation.technicalScore.toFixed(2),
    totalScore: quotation.totalScore === null ? null : quotation.totalScore.toFixed(2),
    rank: quotation.rank,
  };
}
