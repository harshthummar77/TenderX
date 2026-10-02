import type { Delivery, DeliveryItem, Grn, GrnItem, PurchaseOrderItem } from '@prisma/client';
import type { DeliveryDto, DeliveryItemDto, GrnDto, GrnItemDto } from '@tb/shared';
import { qtyToApi } from '../../lib/money.js';

export type GrnWithRelations = Grn & {
  items: (GrnItem & { purchaseOrderItem?: PurchaseOrderItem | null })[];
  purchaseOrder?: { id: string; poNumber: string } | null;
  delivery?: { id: string; challanNumber: string } | null;
};

export type DeliveryWithLines = Delivery & {
  items: (DeliveryItem & { purchaseOrderItem?: PurchaseOrderItem | null })[];
  purchaseOrder?: { id: string; poNumber: string; vendorName: string } | null;
};

const toGrnItemDto = (
  item: GrnItem & { purchaseOrderItem?: PurchaseOrderItem | null },
): GrnItemDto => ({
  id: item.id,
  purchaseOrderItemId: item.purchaseOrderItemId,
  srNo: item.purchaseOrderItem?.srNo ?? null,
  description: item.purchaseOrderItem?.description ?? null,
  unit: item.purchaseOrderItem?.unit ?? null,
  receivedQuantity: qtyToApi(item.receivedQuantity),
  acceptedQuantity: qtyToApi(item.acceptedQuantity),
  rejectedQuantity: qtyToApi(item.rejectedQuantity),
  rejectionReason: item.rejectionReason,
});

/**
 * One shape for both sides. A goods receipt is the buyer's record of what
 * arrived, and the vendor is entitled to see it in full — especially the
 * rejected quantities and the reason, which are the only way they can act on it.
 */
export const toGrnDto = (
  grn: GrnWithRelations,
  receivedByName: string | null = null,
): GrnDto => ({
  id: grn.id,
  grnNumber: grn.grnNumber,
  purchaseOrderId: grn.purchaseOrderId,
  poNumber: grn.purchaseOrder?.poNumber ?? null,
  deliveryId: grn.deliveryId,
  challanNumber: grn.delivery?.challanNumber ?? null,
  status: grn.status,
  receivedById: grn.receivedById,
  receivedByName,
  receivedAt: grn.receivedAt.toISOString(),
  remarks: grn.remarks,
  items: [...grn.items]
    .sort((a, b) => (a.purchaseOrderItem?.srNo ?? 0) - (b.purchaseOrderItem?.srNo ?? 0))
    .map(toGrnItemDto),
  createdAt: grn.createdAt.toISOString(),
});

const toDeliveryItemDto = (
  item: DeliveryItem & { purchaseOrderItem?: PurchaseOrderItem | null },
): DeliveryItemDto => ({
  id: item.id,
  purchaseOrderItemId: item.purchaseOrderItemId,
  srNo: item.purchaseOrderItem?.srNo ?? null,
  description: item.purchaseOrderItem?.description ?? null,
  unit: item.purchaseOrderItem?.unit ?? null,
  quantity: qtyToApi(item.quantity),
});

export const toDeliveryDto = (
  delivery: DeliveryWithLines,
  options: { fullyReceipted?: boolean } = {},
): DeliveryDto => ({
  id: delivery.id,
  purchaseOrderId: delivery.purchaseOrderId,
  poNumber: delivery.purchaseOrder?.poNumber ?? null,
  vendorId: delivery.vendorId,
  vendorName: delivery.purchaseOrder?.vendorName ?? null,
  challanNumber: delivery.challanNumber,
  status: delivery.status,
  dispatchedAt: delivery.dispatchedAt.toISOString(),
  expectedAt: delivery.expectedAt?.toISOString() ?? null,
  deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
  carrierName: delivery.carrierName,
  trackingReference: delivery.trackingReference,
  notes: delivery.notes,
  items: [...delivery.items]
    .sort((a, b) => (a.purchaseOrderItem?.srNo ?? 0) - (b.purchaseOrderItem?.srNo ?? 0))
    .map(toDeliveryItemDto),
  fullyReceipted: options.fullyReceipted ?? delivery.status === 'DELIVERED',
  createdAt: delivery.createdAt.toISOString(),
});
