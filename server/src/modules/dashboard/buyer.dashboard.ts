import type { ActionTile, BuyerDashboard, CategorySplitRow, TopVendorRow } from '@tb/shared';
import { PERMISSIONS, hasPermission } from '@tb/shared';
import { money, round2, sum, toApi, ZERO } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import { monthlySpend } from '../report/spend.report.js';

/**
 * The buyer dashboard (plan 15 §2).
 *
 * **One endpoint, one batch of queries.** Not eight parallel calls that each
 * wake the Neon compute — everything the page needs comes back in one round
 * trip, and the aggregates are computed in SQL rather than by pulling rows into
 * Node and reducing them.
 *
 * **Action first, vanity second.** "3 tenders closing in 24 hours" is worth more
 * than "47 tenders created all-time", and every tile carries the link to the
 * filtered list that produced its count.
 *
 * The officer and admin variants differ by *permission*, not by role name: a
 * tile the actor cannot act on is removed, because showing somebody a count they
 * are not allowed to do anything about is just noise.
 */

const MONTH_MS = 86_400_000;

export async function buildBuyerDashboard(actor: Actor): Promise<BuyerDashboard> {
  const scope = scopeToOrg(actor);
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const in24Hours = new Date(now.getTime() + MONTH_MS);
  const in7Days = new Date(now.getTime() + 7 * MONTH_MS);

  const canApprove = hasPermission(actor.role, PERMISSIONS.APPROVAL_DECIDE);
  const canPay = hasPermission(actor.role, PERMISSIONS.PAYMENT_RECORD);
  const canReviewVendors = hasPermission(actor.role, PERMISSIONS.VENDOR_APPROVE);

  const [
    approvals,
    invoicesToVerify,
    matchExceptions,
    paymentsDue,
    awaitingReceipt,
    vendorsPending,
    draftTenders,
    bidsToEvaluate,
    activeTenders,
    openPo,
    invoicedThisMonth,
    paidThisMonth,
    awardedTenders,
    deliveries,
    topVendorGroups,
    closingSoon,
    recentActivity,
  ] = await Promise.all([
    prisma.approval.aggregate({
      where: { ...scope, status: 'PENDING' },
      _count: true,
      _sum: { amount: true },
    }),
    prisma.invoice.aggregate({
      where: { ...scope, status: 'UNDER_REVIEW' },
      _count: true,
      _sum: { totalAmount: true },
    }),
    prisma.invoice.count({ where: { ...scope, matchStatus: 'EXCEPTION' } }),
    prisma.invoice.aggregate({
      where: {
        ...scope,
        status: { in: ['APPROVED_FOR_PAYMENT', 'PARTIALLY_PAID'] },
        dueDate: { lte: in7Days },
      },
      _count: true,
      _sum: { totalAmount: true },
    }),
    // Dispatched but not yet fully receipted: the storekeeper's queue.
    prisma.delivery.count({
      where: {
        status: { in: ['DISPATCHED', 'IN_TRANSIT'] },
        purchaseOrder: { ...scope },
      },
    }),
    canReviewVendors
      ? prisma.vendor.count({ where: { status: 'PENDING_APPROVAL' } })
      : Promise.resolve(0),
    prisma.tender.count({ where: { ...scope, status: 'DRAFT' } }),
    prisma.tender.count({ where: { ...scope, status: { in: ['BIDDING_CLOSED', 'UNDER_EVALUATION'] } } }),
    prisma.tender.count({ where: { ...scope, status: 'PUBLISHED' } }),
    prisma.purchaseOrder.aggregate({
      where: { ...scope, status: { in: ['ISSUED', 'ACCEPTED'] } },
      _sum: { totalAmount: true },
    }),
    prisma.invoice.aggregate({
      where: {
        ...scope,
        status: { notIn: ['REJECTED', 'CANCELLED', 'DRAFT'] },
        invoiceDate: { gte: startOfMonth },
      },
      _sum: { totalAmount: true },
    }),
    prisma.payment.aggregate({
      where: { ...scope, status: 'COMPLETED', paidAt: { gte: startOfMonth } },
      _sum: { grossAmount: true },
    }),
    prisma.tender.findMany({
      where: { ...scope, awardedAt: { not: null }, publishedAt: { not: null } },
      select: { publishedAt: true, awardedAt: true },
      take: 200,
    }),
    prisma.delivery.findMany({
      where: { deliveredAt: { not: null }, purchaseOrder: { ...scope } },
      select: {
        deliveredAt: true,
        expectedAt: true,
        purchaseOrder: { select: { expectedDeliveryDate: true } },
      },
      take: 500,
    }),
    prisma.purchaseOrder.groupBy({
      by: ['vendorId'],
      where: { ...scope, status: { not: 'CANCELLED' } },
      _sum: { totalAmount: true },
      _count: true,
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: 5,
    }),
    prisma.tender.findMany({
      where: { ...scope, status: 'PUBLISHED', bidSubmissionDeadline: { gte: now, lte: in24Hours } },
      select: {
        id: true,
        referenceNumber: true,
        title: true,
        bidSubmissionDeadline: true,
        _count: { select: { quotations: true } },
      },
      orderBy: { bidSubmissionDeadline: 'asc' },
      take: 10,
    }),
    prisma.activityLog.findMany({
      where: {
        ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
        // SECURITY rows are platform-admin only (plan 14 §C3).
        severity: { not: 'SECURITY' },
      },
      orderBy: { sequence: 'desc' },
      take: 10,
      select: { id: true, action: true, summary: true, severity: true, createdAt: true },
    }),
  ]);

  /* --------------------------------------------------------- action tiles */

  const tiles: ActionTile[] = [];

  if (canApprove && approvals._count > 0) {
    tiles.push({
      key: 'approvals_pending',
      label: 'Awards awaiting your approval',
      count: approvals._count,
      amount: toApi(money(approvals._sum.amount ?? 0)),
      link: '/approvals?status=PENDING',
      severity: 'high',
    });
  }

  if (invoicesToVerify._count > 0) {
    tiles.push({
      key: 'invoices_to_verify',
      label: 'Invoices to verify',
      count: invoicesToVerify._count,
      amount: toApi(money(invoicesToVerify._sum.totalAmount ?? 0)),
      link: '/invoices?status=UNDER_REVIEW',
    });
  }

  if (matchExceptions > 0) {
    tiles.push({
      key: 'match_exceptions',
      label: 'Match exceptions',
      count: matchExceptions,
      link: '/invoices?matchStatus=EXCEPTION',
      severity: 'high',
    });
  }

  if (canPay && paymentsDue._count > 0) {
    tiles.push({
      key: 'payments_due',
      label: 'Payments due this week',
      count: paymentsDue._count,
      amount: toApi(money(paymentsDue._sum.totalAmount ?? 0)),
      link: '/payments/payable',
    });
  }

  if (awaitingReceipt > 0) {
    tiles.push({
      key: 'grn_pending',
      label: 'Deliveries awaiting receipt',
      count: awaitingReceipt,
      link: '/purchase-orders?fulfilmentStatus=PARTIALLY_FULFILLED',
    });
  }

  if (canReviewVendors && vendorsPending > 0) {
    tiles.push({
      key: 'vendors_pending',
      label: 'Vendors awaiting review',
      count: vendorsPending,
      link: '/vendors?status=PENDING_APPROVAL',
    });
  }

  // The officer's own work: drafting tenders and evaluating what came back.
  if (draftTenders > 0) {
    tiles.push({
      key: 'my_draft_tenders',
      label: 'Draft tenders',
      count: draftTenders,
      link: '/tenders?status=DRAFT',
    });
  }

  if (bidsToEvaluate > 0) {
    tiles.push({
      key: 'bids_to_evaluate',
      label: 'Tenders to evaluate',
      count: bidsToEvaluate,
      link: '/tenders?status=UNDER_EVALUATION',
      severity: 'high',
    });
  }

  /* ----------------------------------------------------------------- KPIs */

  const cycleDays = awardedTenders
    .map((tender) =>
      Math.round((tender.awardedAt!.getTime() - tender.publishedAt!.getTime()) / MONTH_MS),
    )
    .filter((days) => days >= 0);

  let onTime = 0;
  for (const delivery of deliveries) {
    const due = delivery.expectedAt ?? delivery.purchaseOrder.expectedDeliveryDate;
    if (delivery.deliveredAt!.getTime() <= due.getTime()) onTime += 1;
  }

  /* -------------------------------------------------------- vendors, split */

  const vendorNames = await prisma.vendor.findMany({
    where: { id: { in: topVendorGroups.map((group) => group.vendorId) } },
    select: { id: true, companyName: true, rating: true },
  });
  const vendorOf = new Map(vendorNames.map((vendor) => [vendor.id, vendor]));

  const topVendors: TopVendorRow[] = topVendorGroups.map((group) => {
    const vendor = vendorOf.get(group.vendorId);
    return {
      vendorId: group.vendorId,
      name: vendor?.companyName ?? group.vendorId,
      poValue: toApi(money(group._sum.totalAmount ?? 0)),
      orders: group._count,
      rating: vendor?.rating === null || vendor?.rating === undefined ? null : vendor.rating.toFixed(2),
    };
  });

  const byCategory = await categorySplit(scope);

  /* ---------------------------------------------------------- spend trend */

  const trendFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
  const trend = scope.organizationId
    ? await monthlySpend(scope.organizationId, trendFrom, now)
    : [];

  return {
    role: actor.role === 'ORG_ADMIN' ? 'ORG_ADMIN' : 'ORG_OFFICER',
    actionRequired: tiles,
    kpis: {
      activeTenders,
      openPoValue: toApi(money(openPo._sum.totalAmount ?? 0)),
      invoicedThisMonth: toApi(money(invoicedThisMonth._sum.totalAmount ?? 0)),
      paidThisMonth: toApi(money(paidThisMonth._sum.grossAmount ?? 0)),
      avgCycleDays:
        cycleDays.length === 0
          ? null
          : Math.round(cycleDays.reduce((total, days) => total + days, 0) / cycleDays.length),
      onTimeDeliveryRate:
        deliveries.length === 0
          ? null
          : round2((onTime / deliveries.length) * 100).toNumber(),
    },
    spendTrend: trend.map((row) => ({
      month: row.month,
      committed: toApi(money(row.committed)),
      invoiced: toApi(money(row.invoiced)),
      paid: toApi(money(row.paid)),
    })),
    topVendors,
    byCategory,
    closingSoon: closingSoon.map((tender) => ({
      tenderId: tender.id,
      reference: tender.referenceNumber || null,
      title: tender.title,
      deadline: tender.bidSubmissionDeadline.toISOString(),
      bidCount: tender._count.quotations,
    })),
    recentActivity: recentActivity.map((row) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      severity: row.severity,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Committed spend per tender category, with each slice's share of the whole. */
async function categorySplit(scope: { organizationId?: string }): Promise<CategorySplitRow[]> {
  const orders = await prisma.purchaseOrder.findMany({
    where: { ...scope, status: { not: 'CANCELLED' } },
    select: { totalAmount: true, tender: { select: { category: { select: { name: true } } } } },
    take: 2000,
  });

  const byName = new Map<string, ReturnType<typeof money>>();
  for (const order of orders) {
    const name = order.tender?.category?.name ?? 'Uncategorised';
    byName.set(name, (byName.get(name) ?? ZERO).plus(money(order.totalAmount)));
  }

  const total = sum([...byName.values()]);

  return [...byName.entries()]
    .map(([category, value]) => ({
      category,
      value: toApi(value),
      share: total.isZero() ? 0 : round2(value.div(total).mul(100)).toNumber(),
    }))
    .sort((a, b) => money(b.value).comparedTo(money(a.value)));
}
