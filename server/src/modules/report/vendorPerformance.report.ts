import type { ReportColumn, ReportResponse, ReportRow, VendorPerformanceQuery } from '@tb/shared';
import { money, round2, sum, toApi } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import { buildScorecard } from '../vendor/scorecard.service.js';
import { reportWindow } from './window.js';

/**
 * Vendor performance (plan 15 §4) — who should we keep buying from?
 *
 * The per-vendor figures come from `buildScorecard`, which plan 06 already
 * wrote: orders, value, on-time rate, acceptance rate, invoice exception rate,
 * bid participation and win rate, and the composite rating with its breakdown.
 * Reimplementing any of that here would give the report and the vendor's own
 * scorecard two chances to disagree about the same vendor.
 *
 * **This is the half of the feedback loop that a human reads.** The other half
 * is `refreshVendorStats`, which writes the same rating back onto the vendor row
 * where plan 07's suggested-vendor ranking and plan 09's `vendorRating`
 * criterion pick it up. A vendor who delivers late scores lower on their next
 * bid, automatically.
 */

const COLUMNS: ReportColumn[] = [
  { key: 'vendor', label: 'Vendor', type: 'string' },
  { key: 'orders', label: 'Orders', type: 'number' },
  { key: 'value', label: 'Order value', type: 'money' },
  { key: 'onTimeRate', label: 'On-time %', type: 'percent' },
  { key: 'avgDelayDays', label: 'Avg delay (days)', type: 'number' },
  { key: 'acceptanceRate', label: 'Accepted %', type: 'percent' },
  { key: 'exceptionRate', label: 'Invoice exception %', type: 'percent' },
  { key: 'participationRate', label: 'Bid participation %', type: 'percent' },
  { key: 'winRate', label: 'Win %', type: 'percent' },
  { key: 'rating', label: 'Rating', type: 'number' },
];

export async function vendorPerformanceReport(
  actor: Actor,
  query: VendorPerformanceQuery,
): Promise<ReportResponse> {
  const scope = scopeToOrg(actor);
  const { from, to } = reportWindow(query);

  /*
   * Only vendors this organization has actually transacted with. Reporting on
   * every vendor on the platform would both leak other buyers' suppliers and
   * fill the page with rows of nulls.
   */
  const transacted = await prisma.purchaseOrder.findMany({
    where: {
      ...scope,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      createdAt: { lte: to },
    },
    select: { vendorId: true },
    distinct: ['vendorId'],
  });

  const vendorIds = transacted.map((row) => row.vendorId);
  const vendors = await prisma.vendor.findMany({
    where: { id: { in: vendorIds } },
    select: { id: true, companyName: true },
  });
  const nameOf = new Map(vendors.map((vendor) => [vendor.id, vendor.companyName]));

  const rows: ReportRow[] = [];

  for (const vendorId of vendorIds) {
    const card = await buildScorecard(vendorId);

    rows.push({
      vendor: nameOf.get(vendorId) ?? vendorId,
      orders: card.orders.total,
      value: card.value.awarded,
      onTimeRate: card.delivery.onTimeRate,
      avgDelayDays: card.delivery.avgDelayDays,
      acceptanceRate:
        card.quality.rejectionRate === null
          ? null
          : round2(100 - card.quality.rejectionRate).toNumber(),
      exceptionRate: card.invoicing.exceptionRate,
      participationRate: card.bidding.participationRate,
      winRate: card.bidding.winRate,
      rating: card.rating,
    });
  }

  // Best first: that is the order somebody reads a supplier list in.
  rows.sort((a, b) => Number(b.rating ?? -1) - Number(a.rating ?? -1));

  const orders = rows.reduce((total, row) => total + Number(row.orders ?? 0), 0);
  const value = toApi(round2(sum(rows.map((row) => money((row.value as string) ?? 0)))));

  /** Weighted by orders, not a mean of means — a one-order vendor must not swing it. */
  const weightedRate = (key: string): number | null => {
    const scored = rows.filter((row) => row[key] !== null && Number(row.orders ?? 0) > 0);
    if (scored.length === 0) return null;

    const weight = scored.reduce((total, row) => total + Number(row.orders), 0);
    if (weight === 0) return null;

    const weighted = scored.reduce(
      (total, row) => total + Number(row[key]) * Number(row.orders),
      0,
    );
    return round2(weighted / weight).toNumber();
  };

  return {
    report: 'vendor-performance',
    params: {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    },
    columns: COLUMNS,
    rows,
    totals: {
      orders,
      value,
      onTimeRate: weightedRate('onTimeRate'),
      acceptanceRate: weightedRate('acceptanceRate'),
      exceptionRate: weightedRate('exceptionRate'),
    },
    meta: { generatedAt: new Date().toISOString(), rowCount: rows.length },
  };
}
