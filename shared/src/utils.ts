import { CURRENCY_SYMBOL, STATE_BY_CODE } from './constants.js';

/* -------------------------------------------------------------------------- */
/* Number formatting (Indian grouping)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Group the integer part the Indian way: last three digits, then pairs.
 * 12345678.9 → "1,23,45,678.90"
 *
 * Works on the string form, so a 16-digit amount never loses precision to a
 * float. Never pass money through `Number()` (00 §6).
 */
export function formatIndianNumber(value: string | number, decimals = 2): string {
  const raw = typeof value === 'number' ? value.toFixed(decimals) : value.trim();
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;

  const [intPartRaw = '0', fracPartRaw = ''] = unsigned.split('.');
  const intPart = intPartRaw.replace(/^0+(?=\d)/, '');

  let grouped: string;
  if (intPart.length <= 3) {
    grouped = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }

  let frac = '';
  if (decimals > 0) {
    frac = '.' + fracPartRaw.padEnd(decimals, '0').slice(0, decimals);
  }

  return (negative ? '-' : '') + grouped + frac;
}

/** "₹1,23,456.78". Display only — never feed the result back into arithmetic. */
export function formatMoney(value: string | number, withSymbol = true): string {
  const formatted = formatIndianNumber(value, 2);
  if (!withSymbol) return formatted;
  return formatted.startsWith('-')
    ? `-${CURRENCY_SYMBOL}${formatted.slice(1)}`
    : `${CURRENCY_SYMBOL}${formatted}`;
}

/* -------------------------------------------------------------------------- */
/* Amount in words (used on the PO and invoice PDFs)                          */
/* -------------------------------------------------------------------------- */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  const ones = ONES[n % 10] ?? '';
  return ones ? `${tens} ${ones}` : tens;
}

function belowThousand(n: number): string {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/** Integer → Indian words, with lakh / crore grouping. Recurses above 99 crore. */
function integerToIndianWords(value: bigint): string {
  if (value === 0n) return 'Zero';

  const parts: string[] = [];

  const crore = value / 10_000_000n;
  let rest = value % 10_000_000n;
  if (crore > 0n) parts.push(`${integerToIndianWords(crore)} Crore`);

  const lakh = Number(rest / 100_000n);
  rest %= 100_000n;
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);

  const thousand = Number(rest / 1_000n);
  rest %= 1_000n;
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);

  const remainder = Number(rest);
  if (remainder) parts.push(belowThousand(remainder));

  return parts.join(' ');
}

/**
 * "123456.78" → "One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees
 * and Seventy Eight Paise Only"
 *
 * Takes the money string the API emits, so it is exact at any magnitude.
 * Tested exhaustively — this is fiddly and it prints on legal documents.
 */
export function numberToIndianWords(amount: string | number): string {
  const raw = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;

  const [rupeesRaw = '0', paiseRaw = ''] = unsigned.split('.');
  const rupees = BigInt(rupeesRaw === '' ? '0' : rupeesRaw);
  const paise = Number(paiseRaw.padEnd(2, '0').slice(0, 2) || '0');

  const words = [`${integerToIndianWords(rupees)} Rupees`];
  if (paise > 0) words.push(`and ${belowHundred(paise)} Paise`);
  words.push('Only');

  return (negative ? 'Minus ' : '') + words.join(' ');
}

/* -------------------------------------------------------------------------- */
/* GSTIN                                                                      */
/* -------------------------------------------------------------------------- */

const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_STRUCTURE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export interface GstinValidationResult {
  valid: boolean;
  /** Stable reason code, present only when `valid` is false. */
  reason?: 'length' | 'structure' | 'state_code' | 'checksum';
  message?: string;
  /** Parsed pieces, present only when `valid` is true. */
  stateCode?: string;
  stateName?: string;
  pan?: string;
}

/** The 15th character is a mod-36 check digit over the first 14. */
export function gstinChecksum(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = GSTIN_ALPHABET.indexOf(first14[i] as string);
    const factor = i % 2 === 0 ? 1 : 2;
    const product = code * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36] as string;
}

/**
 * Full GSTIN validation: 15 characters, `NN AAAAA NNNN A N Z C` structure,
 * a state code that actually exists, and a verified check digit.
 */
export function validateGstin(gstin: string): GstinValidationResult {
  const value = (gstin ?? '').trim().toUpperCase();

  if (value.length !== 15) {
    return { valid: false, reason: 'length', message: 'GSTIN must be exactly 15 characters' };
  }
  if (!GSTIN_STRUCTURE.test(value)) {
    return {
      valid: false,
      reason: 'structure',
      message: 'GSTIN format must be 2 digits, 5 letters, 4 digits, 1 letter, 1 alphanumeric, Z, 1 alphanumeric',
    };
  }

  const stateCode = value.slice(0, 2);
  const state = STATE_BY_CODE.get(stateCode);
  if (!state) {
    return { valid: false, reason: 'state_code', message: `Unknown GST state code "${stateCode}"` };
  }

  if (gstinChecksum(value.slice(0, 14)) !== value[14]) {
    return { valid: false, reason: 'checksum', message: 'GSTIN check digit is invalid' };
  }

  return {
    valid: true,
    stateCode,
    stateName: state.name,
    pan: value.slice(2, 12),
  };
}

export const isValidGstin = (gstin: string): boolean => validateGstin(gstin).valid;

/** First two characters of a GSTIN — drives intra-state vs inter-state GST (plan 10). */
export const gstinStateCode = (gstin: string): string => gstin.trim().slice(0, 2);

/* -------------------------------------------------------------------------- */
/* Fiscal year                                                                */
/* -------------------------------------------------------------------------- */

/** IST is UTC+05:30, and the Indian fiscal year turns over at midnight IST. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Indian fiscal year label for a UTC instant: 1 Apr – 31 Mar, formatted
 * "2025-26". Used by the document numbering sequence (plan 07):
 * `PO/2025-26/000042`.
 */
export function fiscalYear(date: Date | string = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** UTC instants bounding a fiscal-year label: `[1 Apr 00:00 IST, 1 Apr next 00:00 IST)`. */
export function fiscalYearRange(label: string): { start: Date; end: Date } {
  const startYear = Number(label.slice(0, 4));
  return {
    start: new Date(Date.UTC(startYear, 3, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(startYear + 1, 3, 1) - IST_OFFSET_MS),
  };
}

/* -------------------------------------------------------------------------- */
/* PAN, IFSC, account masking                                                 */
/* -------------------------------------------------------------------------- */

const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/;
/** The fifth character of an IFSC is always zero. */
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const validatePan = (pan: string): boolean => PAN_PATTERN.test((pan ?? '').trim().toUpperCase());

export const validateIfsc = (ifsc: string): boolean =>
  IFSC_PATTERN.test((ifsc ?? '').trim().toUpperCase());

/**
 * Characters 3-12 of a GSTIN are the holder's PAN. When both are on file they
 * must agree — if they do not, one of the two was typed from the wrong document.
 */
export const gstinMatchesPan = (gstin: string, pan: string): boolean =>
  gstin.trim().toUpperCase().slice(2, 12) === pan.trim().toUpperCase();

/**
 * `maskAccount('123456784821') === 'XXXXXX4821'` — the last four digits are
 * enough to recognise an account, and nothing else ever leaves the server
 * except on the payment screen, where the read is audited.
 */
export function maskAccount(accountNumber: string | null | undefined): string | null {
  if (!accountNumber) return null;
  const value = accountNumber.trim();
  if (value.length <= 4) return 'X'.repeat(value.length);
  return 'X'.repeat(value.length - 4) + value.slice(-4);
}
