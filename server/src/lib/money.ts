import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/**
 * Money and quantity arithmetic. Rule with no exceptions:
 * no `parseFloat`, no `Number()`, no `+` on anything that is money.
 */

export const money = (v: Decimal.Value | null | undefined = 0) => new Decimal(v ?? 0);

export const round2 = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const round3 = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);

/** The only way money leaves the server. */
export const toApi = (v: Decimal.Value) => round2(v).toFixed(2);

/** The only way a quantity leaves the server. */
export const qtyToApi = (v: Decimal.Value) => round3(v).toFixed(3);

export const sum = (values: Decimal.Value[]) =>
  values.reduce<Decimal>((acc, v) => acc.plus(money(v)), new Decimal(0));

export const isZero = (v: Decimal.Value) => new Decimal(v).isZero();
export const gt = (a: Decimal.Value, b: Decimal.Value) => new Decimal(a).greaterThan(b);
export const gte = (a: Decimal.Value, b: Decimal.Value) => new Decimal(a).greaterThanOrEqualTo(b);
export const lt = (a: Decimal.Value, b: Decimal.Value) => new Decimal(a).lessThan(b);

export const ZERO = new Decimal(0);

export { Decimal };
