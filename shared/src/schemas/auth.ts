import { z } from 'zod';
import { ROLES } from '../enums.js';
import { emailSchema, gstinSchema, panSchema, phoneSchema, uuidSchema } from './common.js';

/**
 * Auth contracts. The client imports these for form validation, so the password
 * policy is enforced in exactly one place (01 §2 — one schema, two consumers).
 */

/* -------------------------------------------------------------------------- */
/* Password policy                                                            */
/* -------------------------------------------------------------------------- */

export const PASSWORD_MIN_LENGTH = 10;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(200, 'Password is too long')
  .refine((v) => /[A-Za-z]/.test(v), 'Password must contain at least one letter')
  .refine((v) => /\d/.test(v), 'Password must contain at least one digit');

/** The password may not be the local part of the email ("priya" for priya@x.com). */
const notEmailLocalPart = <T extends { email: string; password: string }>(
  data: T,
  ctx: z.RefinementCtx,
) => {
  const local = data.email.split('@')[0]?.toLowerCase() ?? '';
  if (local && data.password.toLowerCase() === local) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['password'],
      message: 'Password must not be your email name',
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Address (shared by both registration payloads)                             */
/* -------------------------------------------------------------------------- */

export const addressSchema = z
  .object({
    addressLine1: z.string().trim().min(1).max(200),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    /** GST state code — drives CGST/SGST vs IGST on every document the party touches. */
    stateCode: z.string().regex(/^\d{2}$/, 'State code must be 2 digits'),
    pincode: z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
    country: z.string().trim().length(2).default('IN'),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

const accountSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    email: emailSchema,
    password: passwordSchema,
    phone: phoneSchema.optional(),
  })
  .strict()
  .superRefine(notEmailLocalPart);

export const registerOrganizationSchema = z
  .object({
    organization: addressSchema.extend({
      name: z.string().trim().min(2).max(200),
      legalName: z.string().trim().max(200).optional(),
      email: emailSchema,
      phone: phoneSchema.optional(),
      gstin: gstinSchema.optional(),
      pan: panSchema.optional(),
    }).strict(),
    admin: accountSchema,
  })
  .strict();

export const registerVendorSchema = z
  .object({
    vendor: addressSchema.extend({
      companyName: z.string().trim().min(2).max(200),
      legalName: z.string().trim().max(200).optional(),
      email: emailSchema,
      phone: phoneSchema,
      gstin: gstinSchema.optional(),
      pan: panSchema.optional(),
    }).strict(),
    admin: accountSchema,
    categoryIds: z.array(uuidSchema).max(20).default([]),
  })
  .strict();

export type RegisterOrganizationInput = z.infer<typeof registerOrganizationSchema>;
export type RegisterVendorInput = z.infer<typeof registerVendorSchema>;

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required').max(200),
  })
  .strict();

export const updateMeSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: phoneSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
  })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'New password must be different',
  });

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: passwordSchema,
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/* -------------------------------------------------------------------------- */
/* Invitations                                                                */
/* -------------------------------------------------------------------------- */

export const createInvitationSchema = z
  .object({
    email: emailSchema,
    fullName: z.string().trim().min(2).max(120).optional(),
    /** Which role the invitee gets. What you may hand out depends on your own role. */
    role: z.enum(ROLES),
  })
  .strict();

export const acceptInvitationSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    password: passwordSchema,
    phone: phoneSchema.optional(),
  })
  .strict();

export const invitationTokenParamSchema = z
  .object({ token: z.string().min(20).max(200) })
  .strict();

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

/* -------------------------------------------------------------------------- */
/* Response DTOs                                                              */
/* -------------------------------------------------------------------------- */

export interface PartySummary {
  id: string;
  name: string;
  status: string;
}

export interface MeDto {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: (typeof ROLES)[number];
  status: string;
  organization: PartySummary | null;
  vendor: PartySummary | null;
  lastLoginAt: string | null;
}

export interface SessionDto {
  accessToken: string;
  expiresIn: number;
  user: MeDto;
}

export interface InvitationPreviewDto {
  email: string;
  role: (typeof ROLES)[number];
  partyName: string | null;
  expiresAt: string;
}
