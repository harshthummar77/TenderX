import { z } from 'zod';
import { STATE_BY_CODE, UNITS } from '../constants.js';
import { FULFILMENT_STATUSES, PO_STATUSES } from '../enums.js';
import {
  hsnSchema,
  isoDateTimeSchema,
  moneySchema,
  paginationQuerySchema,
  positiveQuantitySchema,
  uuidSchema,
} from './common.js';

/**
 * Purchase orders (plan 10).
 *
 * Nothing here accepts a tax figure. The GST engine in `lib/tax.ts` derives
 * every one of them from the quantity, the unit price, the discount and the
 * place of supply — a client that could post `igstAmount` could post a document
 * that does not add up, and a tax document that does not add up is worse than
 * no document.
 */

const stateCodeSchema = z
  .string()
  .regex(/^\d{2}$/, 'State code must be 2 digits')
  .refine((code) => STATE_BY_CODE.has(code), 'Unknown GST state code');

/** A rejection is a contract refusal; it needs a reason somebody can act on. */
export const PO_REJECTION_REASON_MIN_LENGTH = 20;

/** A direct PO skips the tender, so the justification is the only record of why. */
export const DIRECT_PO_JUSTIFICATION_MIN_LENGTH = 30;

export const rejectPoSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(
        PO_REJECTION_REASON_MIN_LENGTH,
        `Give a reason of at least ${PO_REJECTION_REASON_MIN_LENGTH} characters`,
      )
      .max(2000),
  })
  .strict();

export const cancelPoSchema = z
  .object({ reason: z.string().trim().min(10, 'Give a reason').max(2000) })
  .strict();

export const acceptPoSchema = z
  .object({ note: z.string().trim().max(1000).optional() })
  .strict()
  .optional()
  .default({});

/* -------------------------------------------------------------------------- */
/* Direct purchase orders (10 §7)                                             */
/* -------------------------------------------------------------------------- */

export const directPoItemSchema = z
  .object({
    srNo: z.number().int().min(1).max(100),
    description: z.string().trim().min(3).max(500),
    hsnCode: hsnSchema.optional(),
    unit: z.enum(UNITS),
    quantity: positiveQuantitySchema,
    unitPrice: moneySchema,
    discountPercent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Must be a percentage')
      .refine((v) => Number(v) <= 100, 'Cannot exceed 100')
      .default('0.00'),
    taxRatePercent: z
      .string()
      .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Tax rate must be a percentage')
      .default('18.00'),
  })
  .strict();

/**
 * A purchase order with no tender behind it — for repeat or low-value buying.
 * Real procurement does not tender every pencil, and pretending otherwise makes
 * the system look naive.
 */
export const createDirectPoSchema = z
  .object({
    vendorId: uuidSchema,
    /** Where the goods land, which is what decides the tax regime (10 §3 rule 3). */
    placeOfSupplyStateCode: stateCodeSchema,
    deliveryAddress: z.string().trim().min(3).max(300),
    expectedDeliveryDate: isoDateTimeSchema,
    freightAmount: moneySchema.default('0.00'),
    paymentTerms: z.string().trim().max(500).optional(),
    termsAndConditions: z.string().trim().max(10_000).optional(),
    justification: z
      .string()
      .trim()
      .min(
        DIRECT_PO_JUSTIFICATION_MIN_LENGTH,
        `Explain why this purchase is not tendered, in at least ${DIRECT_PO_JUSTIFICATION_MIN_LENGTH} characters`,
      )
      .max(2000),
    items: z.array(directPoItemSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const serials = value.items.map((item) => item.srNo).sort((a, b) => a - b);
    const expected = value.items.map((_item, index) => index + 1);
    if (JSON.stringify(serials) !== JSON.stringify(expected)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Item serial numbers must run 1..n with no gaps or duplicates',
      });
    }
  });

/** Amend a REJECTED purchase order before reissuing it (10 §5). */
export const amendPoSchema = z
  .object({
    expectedDeliveryDate: isoDateTimeSchema.optional(),
    deliveryAddress: z.string().trim().min(3).max(300).optional(),
    freightAmount: moneySchema.optional(),
    paymentTerms: z.string().trim().max(500).nullable().optional(),
    termsAndConditions: z.string().trim().max(10_000).nullable().optional(),
    items: z.array(directPoItemSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to amend');

export const poQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PO_STATUSES).optional(),
  fulfilmentStatus: z.enum(FULFILMENT_STATUSES).optional(),
  vendorId: uuidSchema.optional(),
  tenderId: uuidSchema.optional(),
});

export type DirectPoItemInput = z.infer<typeof directPoItemSchema>;
export type CreateDirectPoInput = z.infer<typeof createDirectPoSchema>;
export type AmendPoInput = z.infer<typeof amendPoSchema>;
export type RejectPoInput = z.infer<typeof rejectPoSchema>;
export type CancelPoInput = z.infer<typeof cancelPoSchema>;
export type PoQuery = z.infer<typeof poQuerySchema>;

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

export interface PoItemDto {
  id: string;
  srNo: number;
  tenderItemId: string | null;
  description: string;
  hsnCode: string | null;
  unit: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxableValue: string;
  taxRatePercent: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal: string;
  receivedQuantity: string;
  acceptedQuantity: string;
  invoicedQuantity: string;
}

/** The frozen party snapshot. Never re-read from the live party rows (10 §2). */
export interface PoPartyDto {
  name: string;
  gstin: string | null;
  address: string;
  stateCode: string;
  stateName: string | null;
}

export interface PurchaseOrderDto {
  id: string;
  poNumber: string;
  status: string;
  fulfilmentStatus: string;
  tenderId: string | null;
  quotationId: string | null;
  vendorId: string;
  buyer: PoPartyDto;
  vendor: PoPartyDto;
  placeOfSupplyStateCode: string;
  placeOfSupplyStateName: string | null;
  taxRegime: string;
  /** CGST+SGST, IGST, or neither. A document never prints both sets. */
  taxHeads: string[];
  subtotal: string;
  discountAmount: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  freightAmount: string;
  roundOff: string;
  totalAmount: string;
  totalAmountInWords: string;
  currency: string;
  expectedDeliveryDate: string;
  deliveryAddress: string;
  paymentTerms: string | null;
  termsAndConditions: string | null;
  items: PoItemDto[];
  issuedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  closedAt: string | null;
  /** True once the vendor has had longer than the response window (10 §5). */
  awaitingResponse: boolean;
  createdAt: string;
}

export type LineFulfilmentStatus = 'PENDING' | 'PARTIAL' | 'COMPLETE' | 'OVER_RECEIVED';

export interface FulfilmentLineDto {
  purchaseOrderItemId: string;
  srNo: number;
  description: string;
  unit: string;
  ordered: string;
  received: string;
  accepted: string;
  rejected: string;
  invoiced: string;
  /** `ordered − received`. What plan 11 still expects to arrive. */
  pendingDelivery: string;
  /** `accepted − invoiced`. What plan 12 prefills an invoice with. */
  pendingInvoice: string;
  status: LineFulfilmentStatus;
}

export interface FulfilmentDto {
  purchaseOrderId: string;
  fulfilmentStatus: string;
  overall: {
    orderedValue: string;
    receivedPercent: string;
    invoicedValue: string;
    paidValue: string;
  };
  lines: FulfilmentLineDto[];
}
