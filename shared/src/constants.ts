/**
 * Reference data both apps need. Nothing here hits the database.
 */

export interface IndianState {
  /** GST state code — the first two digits of every GSTIN. */
  code: string;
  name: string;
  /** Two-letter abbreviation used in addresses. */
  abbr: string;
}

/**
 * GST state codes as they stand after the 2020 union-territory mergers.
 * Legacy codes 25 (Daman & Diu) and 28 (undivided Andhra Pradesh) are gone:
 * 25 folded into 26, and 28 was replaced by 37.
 */
export const INDIAN_STATES: readonly IndianState[] = [
  { code: '01', name: 'Jammu and Kashmir', abbr: 'JK' },
  { code: '02', name: 'Himachal Pradesh', abbr: 'HP' },
  { code: '03', name: 'Punjab', abbr: 'PB' },
  { code: '04', name: 'Chandigarh', abbr: 'CH' },
  { code: '05', name: 'Uttarakhand', abbr: 'UK' },
  { code: '06', name: 'Haryana', abbr: 'HR' },
  { code: '07', name: 'Delhi', abbr: 'DL' },
  { code: '08', name: 'Rajasthan', abbr: 'RJ' },
  { code: '09', name: 'Uttar Pradesh', abbr: 'UP' },
  { code: '10', name: 'Bihar', abbr: 'BR' },
  { code: '11', name: 'Sikkim', abbr: 'SK' },
  { code: '12', name: 'Arunachal Pradesh', abbr: 'AR' },
  { code: '13', name: 'Nagaland', abbr: 'NL' },
  { code: '14', name: 'Manipur', abbr: 'MN' },
  { code: '15', name: 'Mizoram', abbr: 'MZ' },
  { code: '16', name: 'Tripura', abbr: 'TR' },
  { code: '17', name: 'Meghalaya', abbr: 'ML' },
  { code: '18', name: 'Assam', abbr: 'AS' },
  { code: '19', name: 'West Bengal', abbr: 'WB' },
  { code: '20', name: 'Jharkhand', abbr: 'JH' },
  { code: '21', name: 'Odisha', abbr: 'OD' },
  { code: '22', name: 'Chhattisgarh', abbr: 'CG' },
  { code: '23', name: 'Madhya Pradesh', abbr: 'MP' },
  { code: '24', name: 'Gujarat', abbr: 'GJ' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', abbr: 'DD' },
  { code: '27', name: 'Maharashtra', abbr: 'MH' },
  { code: '29', name: 'Karnataka', abbr: 'KA' },
  { code: '30', name: 'Goa', abbr: 'GA' },
  { code: '31', name: 'Lakshadweep', abbr: 'LD' },
  { code: '32', name: 'Kerala', abbr: 'KL' },
  { code: '33', name: 'Tamil Nadu', abbr: 'TN' },
  { code: '34', name: 'Puducherry', abbr: 'PY' },
  { code: '35', name: 'Andaman and Nicobar Islands', abbr: 'AN' },
  { code: '36', name: 'Telangana', abbr: 'TS' },
  { code: '37', name: 'Andhra Pradesh', abbr: 'AP' },
  { code: '38', name: 'Ladakh', abbr: 'LA' },
  { code: '97', name: 'Other Territory', abbr: 'OT' },
] as const;

export const STATE_BY_CODE: ReadonlyMap<string, IndianState> = new Map(
  INDIAN_STATES.map((s) => [s.code, s]),
);

/** Units of measure available on a tender line item. */
export const UNITS = [
  'NOS',
  'PCS',
  'SET',
  'PAIR',
  'DOZ',
  'KG',
  'GM',
  'TON',
  'LTR',
  'ML',
  'MTR',
  'CM',
  'SQM',
  'CBM',
  'BOX',
  'PKT',
  'BAG',
  'ROLL',
  'DRUM',
  'HOUR',
  'DAY',
  'MONTH',
  'JOB',
  'LOT',
] as const;
export type Unit = (typeof UNITS)[number];

/** GST rates in force. Percentages, not fractions. */
export const TAX_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;
export type TaxRate = (typeof TAX_RATES)[number];

/** Categories in the `Document` registry (plan 14). */
export const DOC_TYPES = [
  'GST_CERTIFICATE',
  'PAN_CARD',
  'CANCELLED_CHEQUE',
  'INCORPORATION_CERTIFICATE',
  'MSME_CERTIFICATE',
  'ISO_CERTIFICATE',
  'TENDER_DOCUMENT',
  'QUOTATION_ATTACHMENT',
  'DELIVERY_CHALLAN',
  'INVOICE_COPY',
  'PAYMENT_PROOF',
  'OTHER',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Pagination limits — enforced by the shared query schema and the API. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const CURRENCY = 'INR';
export const CURRENCY_SYMBOL = '₹';
