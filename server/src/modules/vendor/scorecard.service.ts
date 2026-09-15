import type { ScorecardFactor, VendorScorecard } from '@tb/shared';
import { Decimal, money, qtyToApi, toApi } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { NotFound } from '../../lib/errors.js';

/**
 * Computed on read from rows that already exist — nothing here is stored,
 * except the cached `rating` / `onTimeDeliveryRate` columns that plan 15
 * refreshes for sorting.
 *
 * Returning `ratingBreakdown` rather than a bare number means the vendor can see
 * *why* they scored 4.2, and it gives plan 09 an explainable input instead of a
 * magic constant.
 */

const WEIGHTS = {
  onTime: 40,
  quality: 30,
  invoiceAccuracy: 20,
  participation: 10,
} as const;

const percent = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 100;

export async function buildScorecard(vendorId: string): Promise<VendorScorecard> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { createdAt: true } });
  if (!vendor) throw NotFound('Vendor');

  const [purchaseOrders, deliveries, grnItems, invoices, invitations, quotations] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { vendorId },
      select: { id: true, status: true, totalAmount: true, expectedDeliveryDate: true, createdAt: true },
    }),
    prisma.delivery.findMany({
      where: { vendorId },
      select: {
        deliveredAt: true,
        expectedAt: true,
        purchaseOrder: { select: { expectedDeliveryDate: true } },
      },
    }),
    prisma.grnItem.findMany({
      where: { purchaseOrderItem: { purchaseOrder: { vendorId } } },
      select: { receivedQuantity: true, acceptedQuantity: true },
    }),
    prisma.invoice.findMany({
      where: { vendorId },
      select: { status: true, matchStatus: true, totalAmount: true, amountPaid: true },
    }),
    prisma.tenderInvitation.count({ where: { vendorId } }),
    prisma.quotation.findMany({ where: { vendorId }, select: { status: true } }),
  ]);

  /* ------------------------------------------------------------------ orders */
  const orders = {
    total: purchaseOrders.length,
    completed: purchaseOrders.filter((po) => po.status === 'CLOSED').length,
    cancelled: purchaseOrders.filter((po) => po.status === 'CANCELLED').length,
    inProgress: purchaseOrders.filter((po) => po.status === 'ISSUED' || po.status === 'ACCEPTED').length,
  };

  /* ------------------------------------------------------------------- value */
  const awarded = purchaseOrders.reduce((sum, po) => sum.plus(money(po.totalAmount)), new Decimal(0));
  const invoiced = invoices.reduce((sum, inv) => sum.plus(money(inv.totalAmount)), new Decimal(0));
  const paid = invoices.reduce((sum, inv) => sum.plus(money(inv.amountPaid)), new Decimal(0));

  /* ---------------------------------------------------------------- delivery */
  // Against the delivery's own promised date where it has one, else the PO date.
  let onTime = 0;
  let late = 0;
  let totalDelayDays = 0;

  for (const delivery of deliveries) {
    if (!delivery.deliveredAt) continue;
    const due = delivery.expectedAt ?? delivery.purchaseOrder.expectedDeliveryDate;
    const delayMs = delivery.deliveredAt.getTime() - due.getTime();
    if (delayMs <= 0) {
      onTime += 1;
    } else {
      late += 1;
      totalDelayDays += delayMs / 86_400_000;
    }
  }

  const deliveredCount = onTime + late;
  const delivery = {
    onTime,
    late,
    onTimeRate: percent(onTime, deliveredCount),
    avgDelayDays: late === 0 ? null : Math.round((totalDelayDays / late) * 100) / 100,
  };

  /* ----------------------------------------------------------------- quality */
  const totalReceived = grnItems.reduce((sum, item) => sum.plus(money(item.receivedQuantity)), new Decimal(0));
  const accepted = grnItems.reduce((sum, item) => sum.plus(money(item.acceptedQuantity)), new Decimal(0));
  const rejectionRate = totalReceived.isZero()
    ? null
    : Math.round(totalReceived.minus(accepted).div(totalReceived).times(10_000).toNumber()) / 100;

  /* --------------------------------------------------------------- invoicing */
  const submittedInvoices = invoices.filter((inv) => inv.status !== 'DRAFT');
  const matched = invoices.filter((inv) => inv.matchStatus === 'MATCHED').length;
  const exceptions = invoices.filter((inv) => inv.matchStatus === 'EXCEPTION').length;

  const invoicing = {
    submitted: submittedInvoices.length,
    matched,
    exceptions,
    exceptionRate: percent(exceptions, submittedInvoices.length),
  };

  /* ----------------------------------------------------------------- bidding */
  const submittedQuotes = quotations.filter((q) => q.status !== 'DRAFT').length;
  const won = quotations.filter((q) => q.status === 'AWARDED').length;

  const bidding = {
    invited: invitations,
    submitted: submittedQuotes,
    won,
    participationRate: percent(submittedQuotes, invitations),
    winRate: percent(won, submittedQuotes),
  };

  /* ------------------------------------------------------------------ rating */
  const acceptanceScore = totalReceived.isZero()
    ? null
    : Math.round(accepted.div(totalReceived).times(10_000).toNumber()) / 100;
  const invoiceAccuracy = invoicing.submitted === 0 ? null : percent(matched, invoicing.submitted);

  const factors: { factor: string; weight: number; score: number | null }[] = [
    { factor: 'On-time delivery', weight: WEIGHTS.onTime, score: delivery.onTimeRate },
    { factor: 'Quality (acceptance)', weight: WEIGHTS.quality, score: acceptanceScore },
    { factor: 'Invoice accuracy', weight: WEIGHTS.invoiceAccuracy, score: invoiceAccuracy },
    { factor: 'Bid participation', weight: WEIGHTS.participation, score: bidding.participationRate },
  ];

  const scored = factors.filter((f): f is ScorecardFactor => f.score !== null);

  /**
   * A vendor with no history scores `null`, never 0. Plan 09 reads null as a
   * neutral 50 — scoring a new supplier zero would quietly blacklist everyone
   * who has not worked with you yet.
   */
  let rating: number | null = null;
  if (scored.length > 0) {
    const totalWeight = scored.reduce((sum, f) => sum + f.weight, 0);
    const weighted = scored.reduce((sum, f) => sum + f.weight * f.score, 0);
    rating = Math.round((weighted / totalWeight / 20) * 100) / 100;
  }

  const earliest = purchaseOrders.reduce<Date>(
    (min, po) => (po.createdAt < min ? po.createdAt : min),
    vendor.createdAt,
  );

  return {
    vendorId,
    period: { from: earliest.toISOString(), to: new Date().toISOString() },
    orders,
    value: { awarded: toApi(awarded), invoiced: toApi(invoiced), paid: toApi(paid) },
    delivery,
    quality: {
      totalReceived: qtyToApi(totalReceived),
      accepted: qtyToApi(accepted),
      rejectionRate,
    },
    invoicing,
    bidding,
    rating,
    ratingBreakdown: scored,
  };
}
