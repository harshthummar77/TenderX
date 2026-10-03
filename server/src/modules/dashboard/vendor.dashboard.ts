import type { ActionTile, VendorDashboard } from '@tb/shared';
import { money, round2, sum, toApi, ZERO, type Decimal } from '../../lib/money.js';
import { NotFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import type { Actor } from '../../middleware/authenticate.js';
import { buildScorecard } from '../vendor/scorecard.service.js';

/**
 * The vendor dashboard (plan 15 §2).
 *
 * **A vendor sees only their own numbers.** Every query here is filtered by
 * `vendorId`, and there is no branch that aggregates across vendors — the
 * isolation suite checks the same thing from the outside, but the shape of this
 * file is the first defence.
 *
 * The tiles are the vendor's side of the same workflow the buyer sees: respond
 * to invitations, accept orders, invoice what has been accepted, fix what was
 * rejected.
 */

const DAY_MS = 86_400_000;

export async function buildVendorDashboard(actor: Actor): Promise<VendorDashboard> {
  if (!actor.vendorId) throw NotFound('Vendor');
  const vendorId = actor.vendorId;

  const now = new Date();
  const in48Hours = new Date(now.getTime() + 2 * DAY_MS);
  const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

  const [
    openInvitations,
    closingSoon,
    posToAccept,
    rejectedInvoices,
    activeOrders,
    receivables,
    paidThisYear,
    vendor,
    readyToInvoice,
  ] = await Promise.all([
    // Invited, not yet responded to, and still open for bidding.
    prisma.tenderInvitation.count({
      where: {
        vendorId,
        respondedAt: null,
        tender: { status: 'PUBLISHED', bidSubmissionDeadline: { gte: now } },
      },
    }),
    prisma.tenderInvitation.count({
      where: {
        vendorId,
        tender: {
          status: 'PUBLISHED',
          bidSubmissionDeadline: { gte: now, lte: in48Hours },
          // Only count it if they have not already submitted.
          quotations: { none: { vendorId, isLatest: true, status: 'SUBMITTED' } },
        },
      },
    }),
    prisma.purchaseOrder.aggregate({
      where: { vendorId, status: 'ISSUED' },
      _count: true,
      _sum: { totalAmount: true },
    }),
    prisma.invoice.count({ where: { vendorId, status: 'REJECTED' } }),
    prisma.purchaseOrder.count({ where: { vendorId, status: 'ACCEPTED' } }),
    prisma.invoice.findMany({
      where: { vendorId, status: { in: ['APPROVED_FOR_PAYMENT', 'PARTIALLY_PAID'] } },
      select: { totalAmount: true, amountPaid: true, dueDate: true },
    }),
    prisma.payment.aggregate({
      where: { vendorId, status: 'COMPLETED', paidAt: { gte: startOfYear } },
      _sum: { grossAmount: true },
    }),
    prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { rating: true, onTimeDeliveryRate: true },
    }),
    /*
     * Goods accepted but not yet billed — `acceptedQuantity − invoicedQuantity`
     * per line, which is the same definition plan 12's `invoiceable` prefill
     * uses. One definition of "ready to invoice", in both places.
     */
    prisma.purchaseOrderItem.findMany({
      where: { purchaseOrder: { vendorId, status: 'ACCEPTED' } },
      select: {
        quantity: true,
        acceptedQuantity: true,
        invoicedQuantity: true,
        lineTotal: true,
        purchaseOrderId: true,
      },
    }),
  ]);

  /* ---------------------------------------------------- ready to invoice */

  const invoiceableOrders = new Set<string>();
  let invoiceableValue: Decimal = ZERO;

  for (const item of readyToInvoice) {
    const pending = money(item.acceptedQuantity).minus(money(item.invoicedQuantity));
    if (!pending.greaterThan(0)) continue;

    invoiceableOrders.add(item.purchaseOrderId);

    // Apportion the line total by the share still to be billed.
    const ordered = money(item.quantity);
    if (ordered.greaterThan(0)) {
      invoiceableValue = invoiceableValue.plus(money(item.lineTotal).mul(pending).div(ordered));
    }
  }

  /* ---------------------------------------------------------------- tiles */

  const tiles: ActionTile[] = [];

  if (openInvitations > 0) {
    tiles.push({
      key: 'invitations_open',
      label: 'Tender invitations awaiting response',
      count: openInvitations,
      link: '/vendor/tenders?status=PUBLISHED',
    });
  }

  if (closingSoon > 0) {
    tiles.push({
      key: 'bids_closing',
      label: 'Bids closing in 48 hours',
      count: closingSoon,
      link: '/vendor/tenders?status=PUBLISHED',
      severity: 'high',
    });
  }

  if (posToAccept._count > 0) {
    tiles.push({
      key: 'pos_to_accept',
      label: 'Purchase orders to accept',
      count: posToAccept._count,
      amount: toApi(money(posToAccept._sum.totalAmount ?? 0)),
      link: '/vendor/purchase-orders?status=ISSUED',
      severity: 'high',
    });
  }

  if (invoiceableOrders.size > 0) {
    tiles.push({
      key: 'ready_to_invoice',
      label: 'Goods received, ready to invoice',
      count: invoiceableOrders.size,
      amount: toApi(round2(invoiceableValue)),
      link: '/vendor/purchase-orders?status=ACCEPTED',
    });
  }

  if (rejectedInvoices > 0) {
    tiles.push({
      key: 'invoices_rejected',
      label: 'Invoices needing correction',
      count: rejectedInvoices,
      link: '/vendor/invoices?status=REJECTED',
      severity: 'high',
    });
  }

  /* ------------------------------------------------- receivable ageing */

  const buckets = [
    { bucket: 'Not due', from: Number.NEGATIVE_INFINITY, to: 0 },
    { bucket: '0-30', from: 1, to: 30 },
    { bucket: '31-60', from: 31, to: 60 },
    { bucket: '61-90', from: 61, to: 90 },
    { bucket: '90+', from: 91, to: Number.POSITIVE_INFINITY },
  ];

  const ageing = buckets.map((bucket) => ({ bucket: bucket.bucket, amounts: [] as Decimal[] }));
  let outstanding: Decimal = ZERO;

  for (const invoice of receivables) {
    const balance = money(invoice.totalAmount).minus(money(invoice.amountPaid));
    if (!balance.greaterThan(0)) continue;

    outstanding = outstanding.plus(balance);

    const overdue = Math.floor((now.getTime() - invoice.dueDate.getTime()) / DAY_MS);
    const index = buckets.findIndex((b) => overdue >= b.from && overdue <= b.to);
    ageing[index === -1 ? 0 : index]!.amounts.push(balance);
  }

  /* ---------------------------------------------------------- bid history */

  const bidHistory = await monthlyBidHistory(vendorId);
  const card = await buildScorecard(vendorId);

  return {
    role: 'VENDOR',
    actionRequired: tiles,
    kpis: {
      winRate: card.bidding.winRate,
      activeOrders,
      outstandingReceivable: toApi(round2(outstanding)),
      paidThisYear: toApi(money(paidThisYear._sum.grossAmount ?? 0)),
      rating: vendor.rating === null ? null : vendor.rating.toFixed(2),
      onTimeDeliveryRate:
        vendor.onTimeDeliveryRate === null
          ? card.delivery.onTimeRate
          : Number(vendor.onTimeDeliveryRate.toFixed(2)),
    },
    receivableAgeing: ageing.map((row) => ({
      bucket: row.bucket,
      amount: toApi(round2(sum(row.amounts))),
    })),
    bidHistory,
  };
}

/**
 * Six months of bids submitted and won, **zero-filled**.
 *
 * `generate_series` builds the month spine first, so a month the vendor did not
 * bid in is a zero bar rather than a gap. A chart that skips a month looks
 * broken, and the reader cannot tell a quiet month from a missing one.
 */
async function monthlyBidHistory(
  vendorId: string,
): Promise<{ month: string; submitted: number; won: number }[]> {
  const rows = await prisma.$queryRaw<{ month: string; submitted: bigint; won: bigint }[]>`
    SELECT
      to_char(m, 'YYYY-MM') AS month,
      (SELECT COUNT(*) FROM quotations q
         WHERE q."vendorId" = ${vendorId}::uuid
           AND q.status <> 'DRAFT'::"QuotationStatus"
           AND date_trunc('month', q."submittedAt") = m) AS submitted,
      (SELECT COUNT(*) FROM quotations q
         WHERE q."vendorId" = ${vendorId}::uuid
           AND q.status = 'AWARDED'::"QuotationStatus"
           AND date_trunc('month', q."submittedAt") = m) AS won
    FROM generate_series(
      date_trunc('month', now() - interval '5 months'),
      date_trunc('month', now()),
      interval '1 month'
    ) AS m
    ORDER BY m`;

  return rows.map((row) => ({
    month: row.month,
    submitted: Number(row.submitted),
    won: Number(row.won),
  }));
}
