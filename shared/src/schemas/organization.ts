import { z } from 'zod';
import { ROLES } from '../enums.js';
import { emailSchema, gstinSchema, panSchema, paginationQuerySchema, phoneSchema } from './common.js';
import { orgSettingsSchema } from './org.js';

/**
 * Organization profile, settings and membership contracts.
 * `orgSettingsSchema` itself lives in `./org.ts` (plan 02 §9) and is re-exported
 * here so callers have one import for everything organization-shaped.
 */
export { orgSettingsSchema };
export type { OrgSettings } from './org.js';

export const updateOrgSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    legalName: z.string().trim().max(200).nullable().optional(),
    email: emailSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    gstin: gstinSchema.nullable().optional(),
    pan: panSchema.nullable().optional(),
    addressLine1: z.string().trim().min(1).max(200).optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    /** Immutable once the org has issued a purchase order — it fixes the tax regime. */
    stateCode: z.string().regex(/^\d{2}$/, 'State code must be 2 digits').optional(),
    pincode: z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits').optional(),
    logoUrl: z.string().url().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/**
 * Settings PATCH is a deep merge, not a replace, so the UI can send one field.
 * Every key is optional here; the merged result is validated against the full
 * `orgSettingsSchema` before it is written.
 */
export const updateSettingsSchema = z
  .object({
    matchTolerancePercent: z.number().min(0).max(10).optional(),
    approvalThresholdAmount: z.number().min(0).optional(),
    allowOfficerApproval: z.boolean().optional(),
    requireGrnBeforeInvoice: z.boolean().optional(),
    minVendorsPerTender: z.number().min(1).optional(),
    defaultPaymentTermDays: z.number().min(0).optional(),
    expectedResponseDays: z.number().min(1).max(60).optional(),
    defaultTaxRatePercent: z.number().min(0).max(28).optional(),
    numberPrefixes: z
      .object({
        TENDER: z.string().trim().min(1).max(8).optional(),
        QUOTATION: z.string().trim().min(1).max(8).optional(),
        PURCHASE_ORDER: z.string().trim().min(1).max(8).optional(),
        GRN: z.string().trim().min(1).max(8).optional(),
        INVOICE: z.string().trim().min(1).max(8).optional(),
        PAYMENT: z.string().trim().min(1).max(8).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/** Only the two organization roles can be invited into an organization. */
export const ORG_INVITABLE_ROLES = ['ORG_ADMIN', 'ORG_OFFICER'] as const;

export const inviteMemberSchema = z
  .object({
    email: emailSchema,
    fullName: z.string().trim().min(2).max(120).optional(),
    role: z.enum(ORG_INVITABLE_ROLES),
  })
  .strict();

export const updateMemberSchema = z
  .object({
    role: z.enum(ORG_INVITABLE_ROLES).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const memberParamSchema = z.object({ userId: z.string().uuid() }).strict();

export const reasonSchema = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();

export const platformOrgQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED']).optional(),
});

export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type PlatformOrgQuery = z.infer<typeof platformOrgQuerySchema>;

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

export interface CompletionCheck {
  key: string;
  label: string;
  done: boolean;
  weight: number;
}

export interface CompletionDto {
  score: number;
  checks: CompletionCheck[];
}

export interface OrganizationDto {
  id: string;
  name: string;
  legalName: string | null;
  email: string;
  phone: string | null;
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
  logoUrl: string | null;
  approvedAt: string | null;
  createdAt: string;
  /** False once a purchase order exists — `stateCode` is frozen from then on. */
  stateCodeEditable: boolean;
  completion: CompletionDto;
}

export interface MemberDto {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: (typeof ROLES)[number];
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PlatformOrgListItem {
  id: string;
  name: string;
  gstin: string | null;
  city: string;
  state: string;
  status: string;
  userCount: number;
  tenderCount: number;
  completionScore: number;
  createdAt: string;
}

export interface PlatformStats {
  organizations: { total: number; active: number; pendingApproval: number };
  vendors: { total: number; approved: number; pendingApproval: number; blacklisted: number };
  tenders: { total: number; live: number; awarded: number };
  /** Money always crosses the wire as a fixed-2 string. */
  financial: { poValue: string; invoiced: string; paid: string };
  users: { total: number; activeLast7Days: number };
  system: { auditRows: number; chainValid: boolean; unsentNotifications: number };
}
