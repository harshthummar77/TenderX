import { z } from 'zod';
import { VENDOR_STATUSES } from '../enums.js';
import {
  emailSchema,
  gstinSchema,
  ifscSchema,
  paginationQuerySchema,
  panSchema,
  phoneSchema,
  uuidSchema,
} from './common.js';

/** Vendor self-registration lives in `./auth.ts` — it creates the first login too. */
export { registerVendorSchema, type RegisterVendorInput } from './auth.js';

export const updateVendorSchema = z
  .object({
    companyName: z.string().trim().min(2).max(200).optional(),
    legalName: z.string().trim().max(200).nullable().optional(),
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    gstin: gstinSchema.nullable().optional(),
    pan: panSchema.nullable().optional(),
    addressLine1: z.string().trim().min(1).max(200).optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    stateCode: z.string().regex(/^\d{2}$/, 'State code must be 2 digits').optional(),
    pincode: z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits').optional(),
    bankName: z.string().trim().max(120).nullable().optional(),
    bankAccountName: z.string().trim().max(120).nullable().optional(),
    bankAccountNumber: z
      .string()
      .trim()
      .regex(/^\d{9,18}$/, 'Account number must be 9-18 digits')
      .nullable()
      .optional(),
    bankIfsc: ifscSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const updateVendorCategoriesSchema = z
  .object({ categoryIds: z.array(uuidSchema).max(20) })
  .strict();

/** Buyer-side directory filters. */
export const vendorQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(200).optional(),
  categoryId: uuidSchema.optional(),
  status: z.enum(VENDOR_STATUSES).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  state: z.string().regex(/^\d{2}$/).optional(),
});

/** A buyer registering a vendor on their behalf; the invite creates the login. */
export const createVendorSchema = z
  .object({
    companyName: z.string().trim().min(2).max(200),
    email: emailSchema,
    phone: phoneSchema,
    addressLine1: z.string().trim().min(1).max(200),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    stateCode: z.string().regex(/^\d{2}$/, 'State code must be 2 digits'),
    pincode: z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
    gstin: gstinSchema.optional(),
    pan: panSchema.optional(),
    categoryIds: z.array(uuidSchema).max(20).default([]),
    /** Invite a contact user for the vendor straight away. */
    contactName: z.string().trim().min(2).max(120).optional(),
  })
  .strict();

export const createCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
export type VendorQuery = z.infer<typeof vendorQuerySchema>;
export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

/* -------------------------------------------------------------------------- */
/* DTOs — three audiences, three shapes (06 §3)                               */
/* -------------------------------------------------------------------------- */

export interface CategoryDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

interface VendorCore {
  id: string;
  companyName: string;
  legalName: string | null;
  email: string;
  phone: string;
  gstin: string | null;
  pan: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  country: string;
  status: string;
  rating: number | null;
  totalOrders: number;
  onTimeDeliveryRate: number | null;
  categories: CategoryDto[];
  createdAt: string;
}

/** What the vendor sees about itself: bank details masked, status reason visible. */
export interface VendorSelfDto extends VendorCore {
  bankName: string | null;
  bankAccountName: string | null;
  /** Masked: `XXXXXX4821`. The raw value never leaves the server here. */
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  statusReason: string | null;
  approvedAt: string | null;
}

/** What a buyer sees in the directory. No bank details, ever. */
export type VendorPublicDto = VendorCore;

/** What the platform reviewer sees: masked bank details plus the KYC checklist. */
export interface VendorAdminDto extends VendorCore {
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  statusReason: string | null;
  approvedAt: string | null;
  missingKyc: { path: string; message: string }[];
  duplicateWarnings: DuplicateWarning[];
  documents: { id: string; type: string; fileName: string; createdAt: string }[];
  userCount: number;
}

export interface DuplicateWarning {
  kind: 'pan' | 'bank_account' | 'email_domain';
  message: string;
  vendorId: string;
  vendorName: string;
}

export interface ScorecardFactor {
  factor: string;
  weight: number;
  score: number;
}

export interface VendorScorecard {
  vendorId: string;
  period: { from: string; to: string };
  orders: { total: number; completed: number; cancelled: number; inProgress: number };
  /** Money as strings, always. */
  value: { awarded: string; invoiced: string; paid: string };
  delivery: { onTime: number; late: number; onTimeRate: number | null; avgDelayDays: number | null };
  quality: { totalReceived: string; accepted: string; rejectionRate: number | null };
  invoicing: { submitted: number; matched: number; exceptions: number; exceptionRate: number | null };
  bidding: {
    invited: number;
    submitted: number;
    won: number;
    participationRate: number | null;
    winRate: number | null;
  };
  /** Null for a vendor with no history — plan 09 reads null as neutral, never zero. */
  rating: number | null;
  ratingBreakdown: ScorecardFactor[];
}
