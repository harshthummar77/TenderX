import { isDraftReference } from '../../lib/numbering.js';
import type { Category, Organization, Quotation, Tender, TenderInvitation, TenderItem } from '@prisma/client';
import type {
  Criterion,
  TenderBuyerDto,
  TenderItemBuyerDto,
  TenderItemVendorDto,
  TenderVendorDto,
} from '@tb/shared';
import { qtyToApi, toApi } from '../../lib/money.js';

/**
 * Two shapes, one model (07 §6).
 *
 * **A vendor must never see `estimatedBudget` or `estimatedUnitPrice.`** They
 * are the buyer's internal ceiling, and a vendor who sees them bids just under
 * the ceiling instead of at their real price — the budget stops being a control
 * and becomes the price. The vendor.spec greps the whole JSON for both.
 */

export type TenderWithRelations = Tender & {
  items?: TenderItem[];
  category?: Category | null;
  organization?: Organization;
  invitations?: TenderInvitation[];
  quotations?: Quotation[];
  _count?: { invitations: number; quotations: number };
};

const daysRemaining = (deadline: Date): number | null => {
  const ms = deadline.getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
};

const criteriaOf = (tender: Tender): Criterion[] =>
  Array.isArray(tender.criteria) ? (tender.criteria as unknown as Criterion[]) : [];

const toItemBuyerDto = (item: TenderItem): TenderItemBuyerDto => ({
  id: item.id,
  srNo: item.srNo,
  description: item.description,
  specifications: item.specifications,
  hsnCode: item.hsnCode,
  unit: item.unit,
  quantity: qtyToApi(item.quantity),
  taxRatePercent: item.taxRatePercent.toString(),
  estimatedUnitPrice: item.estimatedUnitPrice === null ? null : toApi(item.estimatedUnitPrice),
});

/** The vendor's line: identical, minus the buyer's own price expectation. */
const toItemVendorDto = (item: TenderItem): TenderItemVendorDto => ({
  id: item.id,
  srNo: item.srNo,
  description: item.description,
  specifications: item.specifications,
  hsnCode: item.hsnCode,
  unit: item.unit,
  quantity: qtyToApi(item.quantity),
  taxRatePercent: item.taxRatePercent.toString(),
});

export const toTenderBuyerDto = (
  tender: TenderWithRelations,
  counts: { invitations: number; viewed: number; quotations: number },
): TenderBuyerDto => ({
  id: tender.id,
  referenceNumber: isDraftReference(tender.referenceNumber) ? null : tender.referenceNumber,
  title: tender.title,
  description: tender.description,
  category: tender.category ? { id: tender.category.id, name: tender.category.name } : null,
  status: tender.status,
  estimatedBudget: tender.estimatedBudget === null ? null : toApi(tender.estimatedBudget),
  deliveryLocation: tender.deliveryLocation,
  deliveryStateCode: tender.deliveryStateCode,
  deliveryDeadline: tender.deliveryDeadline.toISOString(),
  bidSubmissionDeadline: tender.bidSubmissionDeadline.toISOString(),
  bidOpenedAt: tender.bidOpenedAt?.toISOString() ?? null,
  evaluationMethod: tender.evaluationMethod,
  criteria: criteriaOf(tender),
  termsAndConditions: tender.termsAndConditions,
  items: (tender.items ?? []).map(toItemBuyerDto),
  invitationCount: counts.invitations,
  viewedCount: counts.viewed,
  quotationCount: counts.quotations,
  daysRemaining: daysRemaining(tender.bidSubmissionDeadline),
  publishedAt: tender.publishedAt?.toISOString() ?? null,
  closedAt: tender.closedAt?.toISOString() ?? null,
  cancelledAt: tender.cancelledAt?.toISOString() ?? null,
  cancellationReason: tender.cancellationReason,
  createdAt: tender.createdAt.toISOString(),
});

export const toTenderVendorDto = (
  tender: TenderWithRelations & { organization: Organization },
  context: {
    invitation: TenderInvitation | null;
    quotation: Pick<Quotation, 'id' | 'status' | 'submittedAt'> | null;
  },
): TenderVendorDto => ({
  id: tender.id,
  referenceNumber: isDraftReference(tender.referenceNumber) ? null : tender.referenceNumber,
  title: tender.title,
  description: tender.description,
  category: tender.category ? { id: tender.category.id, name: tender.category.name } : null,
  status: tender.status,
  deliveryLocation: tender.deliveryLocation,
  deliveryStateCode: tender.deliveryStateCode,
  deliveryDeadline: tender.deliveryDeadline.toISOString(),
  bidSubmissionDeadline: tender.bidSubmissionDeadline.toISOString(),
  termsAndConditions: tender.termsAndConditions,
  items: (tender.items ?? []).map(toItemVendorDto),
  // Vendors *should* know how they will be judged.
  criteria: criteriaOf(tender).map((c) => ({
    key: c.key,
    label: c.label,
    weight: c.weight,
    direction: c.direction,
  })),
  buyerOrganization: {
    name: tender.organization.name,
    city: tender.organization.city,
    state: tender.organization.state,
  },
  invitationStatus: context.invitation
    ? {
        invitedAt: context.invitation.invitedAt.toISOString(),
        viewedAt: context.invitation.viewedAt?.toISOString() ?? null,
        respondedAt: context.invitation.respondedAt?.toISOString() ?? null,
      }
    : null,
  myQuotation: context.quotation
    ? {
        id: context.quotation.id,
        status: context.quotation.status,
        submittedAt: context.quotation.submittedAt?.toISOString() ?? null,
      }
    : null,
  daysRemaining: daysRemaining(tender.bidSubmissionDeadline),
});
