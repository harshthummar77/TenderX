import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { money, round2 } from '../src/lib/money.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import {
  completePayment,
  invoiceOf,
  payableInvoice,
  recordPayment,
  withBankDetails,
} from './helpers/payable.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * The concurrency proof for payment completion (plan 13 §5).
 *
 * Two completions against one invoice is a real scenario: an impatient click, a
 * retried request, two people clearing the same worklist. Without the
 * `FOR UPDATE` lock on the invoice row both transactions read the same
 * `amountPaid`, both pass the outstanding check, and both increment — the vendor
 * is overpaid and the `invoice_not_overpaid` CHECK constraint turns a business
 * refusal into a 500.
 *
 * The constraint is the backstop. The lock is the behaviour.
 */
vi.setConfig({ testTimeout: 200_000 });

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

describe('parallel completion', () => {
  /** Plan 13 §10 — exactly one succeeds and amountPaid never exceeds the total. */
  it('admits one of two completions for the full outstanding amount', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    // Two payments, each for the entire balance. Only one can legitimately land.
    const first = await recordPayment(payable, { grossAmount: payable.totalAmount });
    const second = await recordPayment(payable, { grossAmount: payable.totalAmount });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const results = await Promise.all([
      completePayment(payable, first.body.data.id),
      completePayment(payable, second.body.data.id),
    ]);

    const succeeded = results.filter((res) => res.status === 200);
    const refused = results.filter((res) => res.status === 422);

    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // A clean business refusal, not a constraint violation surfacing as a 500.
    expect(refused[0]!.body.error.code).toBe('payment.exceeds_outstanding');
    for (const res of results) expect(res.status).not.toBe(500);

    const invoice = await invoiceOf(payable.invoiceId);
    expect(invoice.amountPaid.toFixed(2)).toBe(payable.totalAmount);
    expect(money(invoice.amountPaid).greaterThan(money(invoice.totalAmount))).toBe(false);
    expect(invoice.status).toBe('PAID');

    const completedCount = await prisma.payment.count({
      where: { invoiceId: payable.invoiceId, status: 'COMPLETED' },
    });
    expect(completedCount).toBe(1);
  });

  /** Two halves are both legitimate, so the lock must serialise rather than refuse. */
  it('admits both completions when the two together fit the balance', async () => {
    const payable = await withBankDetails(await payableInvoice('2.000'));
    const total = money(payable.totalAmount);
    const half = round2(total.div(2)).toFixed(2);
    const rest = round2(total.minus(half)).toFixed(2);

    const first = await recordPayment(payable, { grossAmount: half });
    const second = await recordPayment(payable, { grossAmount: rest });

    const results = await Promise.all([
      completePayment(payable, first.body.data.id),
      completePayment(payable, second.body.data.id),
    ]);

    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    const invoice = await invoiceOf(payable.invoiceId);
    expect(invoice.amountPaid.toFixed(2)).toBe(payable.totalAmount);
    expect(invoice.status).toBe('PAID');
  });

  /** Three at once, to show the lock holds past a pair. */
  it('admits only as many completions as the balance can absorb', async () => {
    const payable = await withBankDetails(await payableInvoice('3.000'));
    const total = money(payable.totalAmount);
    // Each payment is 40% of the total, so only two can ever fit.
    const slice = round2(total.mul('0.4')).toFixed(2);

    const recorded = await Promise.all([
      recordPayment(payable, { grossAmount: slice }),
      recordPayment(payable, { grossAmount: slice }),
      recordPayment(payable, { grossAmount: slice }),
    ]);
    for (const res of recorded) expect(res.status).toBe(201);

    const results = await Promise.all(
      recorded.map((res) => completePayment(payable, res.body.data.id)),
    );

    const succeeded = results.filter((res) => res.status === 200);
    const refused = results.filter((res) => res.status === 422);

    expect(succeeded).toHaveLength(2);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body.error.code).toBe('payment.exceeds_outstanding');

    const invoice = await invoiceOf(payable.invoiceId);
    // 80% paid, so still outstanding and never overpaid.
    expect(money(invoice.amountPaid).lessThan(money(invoice.totalAmount))).toBe(true);
    expect(invoice.status).toBe('PARTIALLY_PAID');
  });

  /**
   * The same completion submitted twice — a double-click rather than two
   * payments. The second must be refused on the state machine, before it can
   * touch the ledger at all.
   */
  it('refuses to complete the same payment twice', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const recorded = await recordPayment(payable, { grossAmount: payable.totalAmount });
    const paymentId = recorded.body.data.id;

    const results = await Promise.all([
      completePayment(payable, paymentId),
      completePayment(payable, paymentId),
    ]);

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 422]);

    const loser = results.find((res) => res.status === 422)!;
    expect(loser.body.error.code).toBe('payment.invalid_transition');

    const invoice = await invoiceOf(payable.invoiceId);
    // Applied once, not twice.
    expect(invoice.amountPaid.toFixed(2)).toBe(payable.totalAmount);
  });
});
