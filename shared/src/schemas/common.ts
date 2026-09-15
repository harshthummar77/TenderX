import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants.js';
import { isValidGstin, validateIfsc } from '../utils.js';

/**
 * Building blocks reused by every module schema. One rule with no exceptions:
 * every object schema ends with `.strict()`, so an unknown key is a 422 instead
 * of something quietly reaching Prisma (01 §7).
 */

export const uuidSchema = z.string().uuid('Must be a valid id');

export const idParamSchema = z.object({ id: uuidSchema }).strict();

/** `?page=1&limit=20&sort=-createdAt` (00 §6). */
export const paginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    sort: z
      .string()
      .regex(/^-?[a-zA-Z][a-zA-Z0-9_]*$/, 'sort must be a field name, optionally prefixed with -')
      .optional(),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Money over the wire is a fixed-2 string, never a number (00 §6). */
export const moneySchema = z
  .string()
  .regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'Must be an amount with at most 2 decimal places');

/** Quantities carry 3 decimals: 0.5 kg, 2.25 m. */
export const quantitySchema = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,3})?$/, 'Must be a quantity with at most 3 decimal places');

export const positiveQuantitySchema = quantitySchema.refine(
  (v) => Number(v) > 0,
  'Must be greater than 0',
);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Must be a valid email address')
  .max(254);

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Must be a 10-digit Indian mobile number');

export const panSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Must be a valid PAN');

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidGstin, 'Must be a valid GSTIN (structure, state code and check digit)');

/** HSN (goods) is 4/6/8 digits; SAC (services) is 6. */
export const hsnSchema = z
  .string()
  .trim()
  .regex(/^\d{4}(\d{2})?(\d{2})?$/, 'HSN/SAC must be 4, 6 or 8 digits');

export const ifscSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(validateIfsc, 'Must be a valid IFSC (4 letters, 0, then 6 alphanumerics)');

export const isoDateTimeSchema = z.string().datetime({ offset: true });
