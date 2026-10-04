import type { PoItemDto } from '@tb/shared';
import { addMoney, multiplyQtyRate } from '@/lib/format';

/**
 * How much of an order has arrived, as a percentage of its value.
 *
 * Value-weighted rather than quantity-weighted on purpose: an order for 12
 * switches and 24 SFP modules is not 66% delivered because 24 of 36 units turned
 * up, when the switches are nine tenths of the money.
 *
 * The list endpoint already includes the line items, so this costs no extra
 * request — the per-line `/fulfilment` call is only needed on the detail screen.
 *
 * The final division is the one place a float appears, and deliberately: it
 * produces a bar width, never a figure anyone reconciles.
 */
export function receivedPercent(items: PoItemDto[] | undefined): number | null {
  if (!items || items.length === 0) return null;

  let ordered = '0.00';
  let received = '0.00';

  for (const item of items) {
    ordered = addMoney(ordered, multiplyQtyRate(item.quantity, item.unitPrice));
    received = addMoney(received, multiplyQtyRate(item.receivedQuantity, item.unitPrice));
  }

  const orderedValue = Number(ordered);
  if (!Number.isFinite(orderedValue) || orderedValue === 0) return null;

  return Math.min(100, (Number(received) / orderedValue) * 100);
}

/** The same idea for invoicing: how much of what was accepted has been billed. */
export function invoicedPercent(items: PoItemDto[] | undefined): number | null {
  if (!items || items.length === 0) return null;

  let accepted = '0.00';
  let invoiced = '0.00';

  for (const item of items) {
    accepted = addMoney(accepted, multiplyQtyRate(item.acceptedQuantity, item.unitPrice));
    invoiced = addMoney(invoiced, multiplyQtyRate(item.invoicedQuantity, item.unitPrice));
  }

  const acceptedValue = Number(accepted);
  if (!Number.isFinite(acceptedValue) || acceptedValue === 0) return null;

  return Math.min(100, (Number(invoiced) / acceptedValue) * 100);
}
