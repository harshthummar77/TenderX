import type { AgeingDto } from '@tb/shared';
import { money, round2, sum, toApi, ZERO, type Decimal } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';

/**
 * Accounts-payable ageing (plan 12 §9).
 *
 * Outstanding is `totalAmount − amountPaid` for invoices that are approved or
 * part-paid. Nothing else counts: a draft is not a liability, a rejected invoice
 * is not owed, and a fully-paid one is settled.
 *
 * The buckets are days past `dueDate`, which is the only reading a finance team
 * recognises — ageing from the invoice date would flatter every supplier by the
 * length of the payment terms.
 */

const BUCKETS = [
  { label: 'Not due', from: Number.NEGATIVE_INFINITY, to: 0 },
  { label: '0-30 days', from: 1, to: 30 },
  { label: '31-60', from: 31, to: 60 },
  { label: '61-90', from: 61, to: 90 },
  { label: '90+', from: 91, to: Number.POSITIVE_INFINITY },
] as const;

const daysPastDue = (dueDate: Date, asOf: Date): number =>
  Math.floor((asOf.getTime() - dueDate.getTime()) / 86_400_000);

export async function getAgeing(actor: Actor, asOf: Date = new Date()): Promise<AgeingDto> {
  const invoices = await prisma.invoice.findMany({
    where: {
      ...scopeToOrg(actor),
      status: { in: ['APPROVED_FOR_PAYMENT', 'PARTIALLY_PAID'] },
    },
    select: {
      vendorId: true,
      dueDate: true,
      totalAmount: true,
      amountPaid: true,
      vendor: { select: { companyName: true } },
    },
  });

  const buckets = BUCKETS.map((bucket) => ({
    label: bucket.label,
    count: 0,
    amounts: [] as Decimal[],
  }));

  const byVendor = new Map<
    string,
    { name: string; outstanding: Decimal; oldestDays: number }
  >();

  for (const invoice of invoices) {
    const outstanding = money(invoice.totalAmount).minus(money(invoice.amountPaid));
    // A credit balance is not a payable; skip rather than netting it off.
    if (!outstanding.greaterThan(0)) continue;

    const overdue = daysPastDue(invoice.dueDate, asOf);
    const index = BUCKETS.findIndex((bucket) => overdue >= bucket.from && overdue <= bucket.to);
    const bucket = buckets[index === -1 ? 0 : index]!;
    bucket.count += 1;
    bucket.amounts.push(outstanding);

    const current = byVendor.get(invoice.vendorId);
    if (current) {
      current.outstanding = current.outstanding.plus(outstanding);
      current.oldestDays = Math.max(current.oldestDays, overdue);
    } else {
      byVendor.set(invoice.vendorId, {
        name: invoice.vendor.companyName,
        outstanding,
        oldestDays: overdue,
      });
    }
  }

  const totalCount = buckets.reduce((count, bucket) => count + bucket.count, 0);
  const totalAmount = sum(buckets.flatMap((bucket) => bucket.amounts));

  return {
    asOf: asOf.toISOString().slice(0, 10),
    buckets: buckets.map((bucket) => ({
      label: bucket.label,
      count: bucket.count,
      amount: toApi(round2(sum(bucket.amounts))),
    })),
    total: { count: totalCount, amount: toApi(round2(totalAmount)) },
    byVendor: [...byVendor.entries()]
      .map(([vendorId, row]) => ({
        vendorId,
        name: row.name,
        outstanding: toApi(round2(row.outstanding)),
        // Negative means nothing is overdue yet; report 0 rather than a lie.
        oldestDays: Math.max(0, row.oldestDays),
      }))
      // Worst payable first: that is the order somebody acts in.
      .sort((a, b) => money(b.outstanding).comparedTo(money(a.outstanding))),
  };
}

/** Invoices whose match was overridden — the report an auditor reads (plan 12 §7). */
export async function getMatchExceptions(actor: Actor) {
  const rows = await prisma.invoice.findMany({
    where: {
      ...scopeToOrg(actor),
      OR: [{ matchStatus: 'OVERRIDDEN' }, { matchStatus: 'EXCEPTION' }],
    },
    include: { vendor: { select: { companyName: true } } },
    orderBy: { invoiceDate: 'desc' },
  });

  return rows.map((invoice) => ({
    id: invoice.id,
    referenceNumber: invoice.referenceNumber,
    vendorInvoiceNumber: invoice.vendorInvoiceNumber,
    vendorName: invoice.vendor.companyName,
    status: invoice.status,
    matchStatus: invoice.matchStatus,
    totalAmount: toApi(invoice.totalAmount),
    overriddenById: invoice.overriddenById,
    overrideReason: invoice.overrideReason,
    outstanding: toApi(
      money(invoice.totalAmount).minus(money(invoice.amountPaid)).lessThan(0)
        ? ZERO
        : money(invoice.totalAmount).minus(money(invoice.amountPaid)),
    ),
  }));
}
