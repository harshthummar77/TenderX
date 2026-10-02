import { z } from 'zod';
import { DELIVERY_STATUSES, GRN_STATUSES } from '../enums.js';
import {
  isoDateTimeSchema,
  paginationQuerySchema,
  positiveQuantitySchema,
  quantitySchema,
  uuidSchema,
} from './common.js';

/**
 * Deliveries and goods receipt (plan 11).
 *
 * Two rules shape every schema here, and both are enforced in the service with
 * exact decimal arithmetic rather than in Zod:
 *
 * 1. **Quantities reconcile exactly**: `accepted + rejected === received`. Zod
 *    cannot do that comparison without `Number()`, which this codebase does not
 *    do to decimals, so it lands in the service as `grn.quantity_mismatch` —
 *    and in a Postgres CHECK constraint behind that.
 * 2. **Everything is cumulative.** A quantity that is fine on its own may still
 *    exceed what is left on the line, so no schema can validate it alone.
 *
 * Note what is absent: a GRN payload cannot carry a `status`. It is derived from
 * the quantities (plan 11 §3) and a client that could choose it could call a
 * fully-rejected receipt `ACCEPTED`.
 */

/* -------------------------------------------------------------------------- */
/* Delivery (vendor side)                                                     */
/* -------------------------------------------------------------------------- */

export const deliveryItemSchema = z
  .object({
    purchaseOrderItemId: uuidSchema,
    quantity: positiveQuantitySchema,
  })
  .strict();

const deliveryBody = {
  challanNumber: z.string().trim().min(1).max(60),
  dispatchedAt: isoDateTimeSchema,
  expectedAt: isoDateTimeSchema.optional(),
  carrierName: z.string().trim().max(120).optional(),
  trackingReference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
};

export const createDeliverySchema = z
  .object({
    ...deliveryBody,
    items: z.array(deliveryItemSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.items.map((item) => item.purchaseOrderItemId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Each order line may appear only once on a delivery',
      });
    }
  });

/** Editable only until the buyer receipts it — after that it is evidence. */
export const updateDeliverySchema = z
  .object({
    challanNumber: deliveryBody.challanNumber.optional(),
    dispatchedAt: isoDateTimeSchema.optional(),
    expectedAt: isoDateTimeSchema.nullable().optional(),
    carrierName: z.string().trim().max(120).nullable().optional(),
    trackingReference: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    items: z.array(deliveryItemSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const cancelDeliverySchema = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();

export const deliveryQuerySchema = paginationQuerySchema.extend({
  status: z.enum(DELIVERY_STATUSES).optional(),
  purchaseOrderId: uuidSchema.optional(),
});

/* -------------------------------------------------------------------------- */
/* GRN (buyer side)                                                           */
/* -------------------------------------------------------------------------- */

/** A rejection that nobody explained is not something the vendor can act on. */
export const GRN_REJECTION_REASON_MIN_LENGTH = 10;

export const grnItemSchema = z
  .object({
    purchaseOrderItemId: uuidSchema,
    receivedQuantity: positiveQuantitySchema,
    /** Zero is legitimate: a whole line can be received and refused. */
    acceptedQuantity: quantitySchema,
    rejectedQuantity: quantitySchema.default('0.000'),
    rejectionReason: z.string().trim().max(1000).optional(),
  })
  .strict();

export const createGrnSchema = z
  .object({
    /** Optional: goods can arrive without the vendor having raised a challan. */
    deliveryId: uuidSchema.optional(),
    receivedAt: isoDateTimeSchema,
    remarks: z.string().trim().max(2000).optional(),
    items: z.array(grnItemSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.items.map((item) => item.purchaseOrderItemId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Each order line may appear only once on a goods receipt',
      });
    }
  });

/**
 * Writing off contracted goods is a financial decision, so it costs a real
 * sentence and an `ORG_ADMIN`.
 */
export const SHORT_CLOSE_REASON_MIN_LENGTH = 20;

export const shortCloseSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(
        SHORT_CLOSE_REASON_MIN_LENGTH,
        `Explain the write-off in at least ${SHORT_CLOSE_REASON_MIN_LENGTH} characters`,
      )
      .max(2000),
  })
  .strict();

export const grnQuerySchema = paginationQuerySchema.extend({
  status: z.enum(GRN_STATUSES).optional(),
  purchaseOrderId: uuidSchema.optional(),
});

export type DeliveryItemInput = z.infer<typeof deliveryItemSchema>;
export type CreateDeliveryInput = z.infer<typeof createDeliverySchema>;
export type UpdateDeliveryInput = z.infer<typeof updateDeliverySchema>;
export type CancelDeliveryInput = z.infer<typeof cancelDeliverySchema>;
export type DeliveryQuery = z.infer<typeof deliveryQuerySchema>;
export type GrnItemInput = z.infer<typeof grnItemSchema>;
export type CreateGrnInput = z.infer<typeof createGrnSchema>;
export type ShortCloseInput = z.infer<typeof shortCloseSchema>;
export type GrnQuery = z.infer<typeof grnQuerySchema>;

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

export interface DeliveryItemDto {
  id: string;
  purchaseOrderItemId: string;
  srNo: number | null;
  description: string | null;
  unit: string | null;
  quantity: string;
}

export interface DeliveryDto {
  id: string;
  purchaseOrderId: string;
  poNumber: string | null;
  vendorId: string;
  vendorName: string | null;
  challanNumber: string;
  status: string;
  dispatchedAt: string;
  expectedAt: string | null;
  deliveredAt: string | null;
  carrierName: string | null;
  trackingReference: string | null;
  notes: string | null;
  items: DeliveryItemDto[];
  /** True once every line on it has been fully receipted. */
  fullyReceipted: boolean;
  createdAt: string;
}

export interface GrnItemDto {
  id: string;
  purchaseOrderItemId: string;
  srNo: number | null;
  description: string | null;
  unit: string | null;
  receivedQuantity: string;
  acceptedQuantity: string;
  rejectedQuantity: string;
  rejectionReason: string | null;
}

export interface GrnDto {
  id: string;
  grnNumber: string;
  purchaseOrderId: string;
  poNumber: string | null;
  deliveryId: string | null;
  challanNumber: string | null;
  /** Derived from the quantities, never chosen (plan 11 §3). */
  status: string;
  receivedById: string;
  receivedByName: string | null;
  receivedAt: string;
  remarks: string | null;
  items: GrnItemDto[];
  createdAt: string;
}

/** The prefilled capture screen: an officer with a challan should not retype it. */
export interface ReceivableLineDto {
  purchaseOrderItemId: string;
  srNo: number;
  description: string;
  unit: string;
  ordered: string;
  alreadyReceived: string;
  pending: string;
  /** What the open deliveries say is on its way, capped at what is pending. */
  suggestedReceive: string;
}

export interface ReceivableDto {
  purchaseOrder: {
    id: string;
    poNumber: string;
    vendorName: string;
    status: string;
    fulfilmentStatus: string;
  };
  openDeliveries: {
    id: string;
    challanNumber: string;
    status: string;
    dispatchedAt: string;
    expectedAt: string | null;
    items: { purchaseOrderItemId: string; quantity: string }[];
  }[];
  lines: ReceivableLineDto[];
}
