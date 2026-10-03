import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';
import { CURRENCY_SYMBOL, formatIndianNumber, formatMoney, numberToIndianWords } from '@tb/shared';

/**
 * Every figure the user reads passes through this file.
 *
 * Two non-negotiables (00 §6):
 *  - Money and quantities are STRINGS end to end. `Number("811792.80")` is
 *    lossy the moment an invoice gets large, so nothing here converts an amount
 *    to a float — the arithmetic helpers at the bottom use BigInt on scaled
 *    integers (paise, milli-units) instead.
 *  - Indian digit grouping, always: ₹8,11,792.80, never ₹811,792.80.
 */

export { formatMoney, formatIndianNumber, numberToIndianWords, CURRENCY_SYMBOL };

/* -------------------------------------------------------------------------- */
/* Numbers                                                                    */
/* -------------------------------------------------------------------------- */

/** Quantities carry three decimals, plus the unit when there is one: "12.500 KG". */
export const formatQty = (value: string | number | null | undefined, unit?: string | null) => {
  if (value === null || value === undefined || value === '') return '—';
  const formatted = formatIndianNumber(value, 3);
  return unit ? `${formatted} ${unit}` : formatted;
};

/** Plain integer counts: "1,24,500". */
export const formatCount = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : formatIndianNumber(value, 0);

/** "18%", "0.25%" — tax rates and scores, trailing zeros trimmed. */
export const formatPercent = (value: number | string | null | undefined, decimals = 2) => {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `${Number(n.toFixed(decimals))}%`;
};

/**
 * Dashboard tiles only: "₹8.12 L", "₹1.24 Cr". A stat card has no room for
 * eleven digits, and the exact figure is one click away on the list screen.
 * Never use this on a table cell, a document or anything someone reconciles.
 */
export function formatMoneyCompact(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const raw = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).split('.')[0] ?? '0';
  const sign = negative ? '-' : '';

  const scaled = (zeroes: number, suffix: string) => {
    const n = Number(digits) / 10 ** zeroes;
    return `${sign}${CURRENCY_SYMBOL}${n.toFixed(n >= 100 ? 0 : 2)} ${suffix}`;
  };

  if (digits.length > 7) return scaled(7, 'Cr');
  if (digits.length > 5) return scaled(5, 'L');
  return formatMoney(raw);
}

/** Upload sizes: "4.2 MB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const date = typeof value === 'string' ? parseISO(value) : value;
  return isValid(date) ? date : null;
};

/** "03 Oct 2026". */
export const formatDate = (value: Date | string | null | undefined, fallback = '—') => {
  const date = toDate(value);
  return date ? format(date, 'dd MMM yyyy') : fallback;
};

/** "03 Oct 2026, 16:45" — the API emits UTC, this renders the viewer's timezone. */
export const formatDateTime = (value: Date | string | null | undefined, fallback = '—') => {
  const date = toDate(value);
  return date ? format(date, 'dd MMM yyyy, HH:mm') : fallback;
};

/** "4 hours ago", "in 2 days" — activity feeds and the notification bell. */
export const formatRelative = (value: Date | string | null | undefined, fallback = '—') => {
  const date = toDate(value);
  return date ? formatDistanceToNowStrict(date, { addSuffix: true }) : fallback;
};

/** `<input type="date">` wants "yyyy-MM-dd" in local time, not an ISO instant. */
export const toDateInputValue = (value: Date | string | null | undefined) => {
  const date = toDate(value);
  return date ? format(date, 'yyyy-MM-dd') : '';
};

/** `<input type="datetime-local">` wants "yyyy-MM-ddTHH:mm". */
export const toDateTimeInputValue = (value: Date | string | null | undefined) => {
  const date = toDate(value);
  return date ? format(date, "yyyy-MM-dd'T'HH:mm") : '';
};

/** Back the other way: a local input value becomes the UTC ISO string the API takes. */
export const fromDateInputValue = (value: string, endOfDay = false): string | null => {
  if (!value) return null;
  const suffix = endOfDay ? 'T23:59:59' : 'T00:00:00';
  const date = new Date(value.includes('T') ? value : `${value}${suffix}`);
  return isValid(date) ? date.toISOString() : null;
};

/* -------------------------------------------------------------------------- */
/* Text                                                                       */
/* -------------------------------------------------------------------------- */

/** `UNDER_EVALUATION` becomes `Under evaluation`. Used for every enum label. */
export const humanize = (value: string | null | undefined): string => {
  if (!value) return '—';
  const words = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** "Priya Sharma" becomes "PS", for the avatar circle in the topbar and timeline. */
export const initials = (name: string | null | undefined): string => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] as string;
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] as string;
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
};

export const truncate = (value: string, max = 60) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/* -------------------------------------------------------------------------- */
/* Decimal arithmetic on strings (no float ever touches money)                */
/* -------------------------------------------------------------------------- */

const SCALE_MONEY = 2;
const SCALE_QTY = 3;

/** "12.5" at scale 2 becomes 1250n. Anything unparseable is 0, never NaN. */
function parseScaled(value: string | number | null | undefined, scale: number): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  const raw = typeof value === 'number' ? value.toFixed(scale) : value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(raw)) return 0n;

  const negative = raw.startsWith('-');
  const [intPart = '0', fracPart = ''] = (negative ? raw.slice(1) : raw).split('.');
  const digits = `${intPart || '0'}${fracPart.padEnd(scale, '0').slice(0, scale)}`;
  const magnitude = BigInt(digits === '' ? '0' : digits);
  return negative ? -magnitude : magnitude;
}

/** 1250n at scale 2 becomes "12.50" — fixed width, which is what the API wants. */
function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${intPart}${fracPart}`;
}

/** Half-up away from zero — the rounding mode the server's money helper uses. */
function rescale(value: bigint, from: number, to: number): bigint {
  if (to >= from) return value * 10n ** BigInt(to - from);
  const divisor = 10n ** BigInt(from - to);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const quotient = magnitude / divisor;
  const rounded = (magnitude % divisor) * 2n >= divisor ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export const addMoney = (...values: (string | number | null | undefined)[]): string =>
  formatScaled(
    values.reduce<bigint>((sum, v) => sum + parseScaled(v, SCALE_MONEY), 0n),
    SCALE_MONEY,
  );

export const subtractMoney = (a: string | number, b: string | number): string =>
  formatScaled(parseScaled(a, SCALE_MONEY) - parseScaled(b, SCALE_MONEY), SCALE_MONEY);

export const addQty = (...values: (string | number | null | undefined)[]): string =>
  formatScaled(
    values.reduce<bigint>((sum, v) => sum + parseScaled(v, SCALE_QTY), 0n),
    SCALE_QTY,
  );

/**
 * quantity (3 dp) × rate (2 dp) → amount (2 dp). The exact product is computed
 * at scale 5 and rounded once, at the end — the same order the server's
 * line-item maths uses, so the footer total the user sees matches the total the
 * API stores.
 */
export const multiplyQtyRate = (quantity: string | number, rate: string | number): string => {
  const product = parseScaled(quantity, SCALE_QTY) * parseScaled(rate, SCALE_MONEY);
  return formatScaled(rescale(product, SCALE_QTY + SCALE_MONEY, SCALE_MONEY), SCALE_MONEY);
};

/** `taxOnAmount('1000.00', 18)` is `'180.00'`. Rates carry up to 2 dp (0.25%). */
export const taxOnAmount = (amount: string | number, ratePercent: number): string => {
  // amount(2) × rate(2) lands at scale 4, and the ÷100 adds 2 more.
  const product = parseScaled(amount, SCALE_MONEY) * parseScaled(ratePercent, SCALE_MONEY);
  return formatScaled(rescale(product, SCALE_MONEY + SCALE_MONEY + 2, SCALE_MONEY), SCALE_MONEY);
};

export const isZeroMoney = (value: string | number | null | undefined) =>
  parseScaled(value, SCALE_MONEY) === 0n;

/** -1 | 0 | 1, for sorting and threshold checks without going through a float. */
export const compareMoney = (a: string | number, b: string | number): number => {
  const left = parseScaled(a, SCALE_MONEY);
  const right = parseScaled(b, SCALE_MONEY);
  return left === right ? 0 : left < right ? -1 : 1;
};

/** Normalise what someone typed: "₹ 8,11,792.8" becomes "811792.8". */
export const sanitizeMoneyInput = (raw: string): string => {
  const cleaned = raw.replace(/[^\d.-]/g, '');
  const negative = cleaned.startsWith('-');
  const [intPart = '', ...rest] = cleaned.replace(/-/g, '').split('.');
  const frac = rest.join('').slice(0, SCALE_MONEY);
  return `${negative ? '-' : ''}${intPart}${rest.length ? `.${frac}` : ''}`;
};

export const sanitizeQtyInput = (raw: string): string => {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const [intPart = '', ...rest] = cleaned.split('.');
  const frac = rest.join('').slice(0, SCALE_QTY);
  return `${intPart}${rest.length ? `.${frac}` : ''}`;
};

/** "8.5" becomes "8.50": what goes on the wire, since the API's regex wants fixed-2. */
export const toMoneyString = (raw: string | number | null | undefined): string =>
  formatScaled(parseScaled(raw, SCALE_MONEY), SCALE_MONEY);

export const toQtyString = (raw: string | number | null | undefined): string =>
  formatScaled(parseScaled(raw, SCALE_QTY), SCALE_QTY);
