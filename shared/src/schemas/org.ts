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
    /**
     * Lets an award below `approvalThresholdAmount` clear without a second
     * person (plan 09 §6). **Off by default, and deliberately so** — the whole
     * point of the approval step is that somebody other than the requester
     * signs off, and an organization that turns this on is choosing speed over
     * that control. Even when enabled it never approves on the requester's
     * behalf: the decision is recorded as a system decision, not theirs.
     */
    allowOfficerApproval: z.boolean().default(false),
    requireGrnBeforeInvoice: z.boolean().default(true),
    minVendorsPerTender: z.number().min(1).default(3),
    defaultPaymentTermDays: z.number().default(30),
    /**
     * Days a vendor is given to accept or reject a purchase order (plan 10 §5).
     * Passing it does NOT auto-cancel the order — silently cancelling a contract
     * because a supplier was slow is wrong. The order is flagged and both sides
     * are told; the buyer decides.
     */
    expectedResponseDays: z.number().min(1).max(60).default(3),
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
