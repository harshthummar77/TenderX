import { z } from 'zod';

/**
 * `Organization.settings` is a JSON column, typed by this schema and parsed on
 * every read. A JSON column instead of eight more columns is deliberate:
 * settings change often and are never queried across rows.
 */
export const orgSettingsSchema = z
  .object({
    /** Three-way match tolerance, in percent (plan 12). */
    matchTolerancePercent: z.number().min(0).max(10).default(2),
    /** Above this value an award or invoice needs ORG_ADMIN approval (plan 09). */
    approvalThresholdAmount: z.number().min(0).default(50000),
    requireGrnBeforeInvoice: z.boolean().default(true),
    minVendorsPerTender: z.number().min(1).default(3),
    defaultPaymentTermDays: z.number().default(30),
    defaultTaxRatePercent: z.number().default(18),
    /** Document number prefixes, per sequence type (plan 07). */
    numberPrefixes: z
      .object({
        TENDER: z.string().default('TND'),
        QUOTATION: z.string().default('QTN'),
        PURCHASE_ORDER: z.string().default('PO'),
        GRN: z.string().default('GRN'),
        INVOICE: z.string().default('INV'),
        PAYMENT: z.string().default('PAY'),
      })
      .default({}),
  })
  .strict();

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

/** Defaults for a brand-new organization; also the fallback when the column is `{}`. */
export const defaultOrgSettings = (): OrgSettings => orgSettingsSchema.parse({});

/** Parse a settings column, falling back to defaults for anything missing. */
export const parseOrgSettings = (value: unknown): OrgSettings =>
  orgSettingsSchema.parse(value ?? {});
