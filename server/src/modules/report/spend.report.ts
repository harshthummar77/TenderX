import type { Prisma } from '@prisma/client';
import type { ReportColumn, ReportResponse, ReportRow, SpendReportQuery } from '@tb/shared';
import { money, round2, sum, toApi, ZERO, type Decimal } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import { reportWindow } from './window.js';

/**
 * Spend analysis (plan 15 §3) — where did the money go?
 *
 * **Three definitions of spend, and they are three different numbers.** They are
 * labelled separately on purpose; a report that showed one "spend" column would
 * be asked why it disagrees with the ledger, and the honest answer is that these
 * measure different things:
 *
 * - **Committed** — `SUM(PurchaseOrder.totalAmount)` for orders not cancelled.
 *   Money *promised*.
 * - **Invoiced** — `SUM(Invoice.totalAmount)` for invoices not rejected or
 *   cancelled. Money *billed*.
 * - **Paid** — `SUM(Payment.grossAmount)` for `COMPLETED` payments. Money
 *   *gone*. Gross, not net: the deducted TDS left the buyer too, it just went to
 *   the tax authority rather than the vendor (plan 13 §1).
 */

const COLUMNS: Record<string, ReportColumn[]> = {
  category: [
    { key: 'category', label: 'Category', type: 'string' },
    { key: 'tenders', label: 'Tenders', type: 'number' },
    { key: 'orders', label: 'Orders', type: 'number' },
    { key: 'committed', label: 'Committed', type: 'money' },
    { key: 'invoiced', label: 'Invoiced', type: 'money' },
    { key: 'paid', label: 'Paid', type: 'money' },
  ],
  vendor: [
    { key: 'vendor', label: 'Vendor', type: 'string' },
    { key: 'orders', label: 'Orders', type: 'number' },
    { key: 'committed', label: 'Committed', type: 'money' },
    { key: 'invoiced', label: 'Invoiced', type: 'money' },
    { key: 'paid', label: 'Paid', type: 'money' },
  ],
  month: [
    { key: 'month', label: 'Month', type: 'string' },
    { key: 'orders', label: 'Orders', type: 'number' },
    { key: 'committed', label: 'Committed', type: 'money' },
    { key: 'invoiced', label: 'Invoiced', type: 'money' },
    { key: 'paid', label: 'Paid', type: 'money' },
  ],
};

interface MonthRow {
  month: string;
  orders: bigint;
  committed: string;
  invoiced: string;
  paid: string;
}

/**
 * The monthly series, **zero-filled by `generate_series`**.
 *
 * A chart that skips July because nothing happened looks broken, and the reader
 * cannot tell a quiet month from a missing one. Building the month spine first
 * and left-joining onto it means a quiet month is a zero bar, which is the truth.
 */
async function monthlySpend(
  organizationId: string,
  from: Date,
  to: Date,
): Promise<MonthRow[]> {
  return prisma.$queryRaw<MonthRow[]>`
    SELECT
      to_char(m, 'YYYY-MM') AS month,
      (SELECT COUNT(*) FROM purchase_orders po
         WHERE po."organizationId" = ${organizationId}::uuid
           AND po.status <> 'CANCELLED'::"PoStatus"
           AND date_trunc('month', po."createdAt") = m) AS orders,
      (SELECT COALESCE(SUM(po."totalAmount"), 0)::text FROM purchase_orders po
         WHERE po."organizationId" = ${organizationId}::uuid
           AND po.status <> 'CANCELLED'::"PoStatus"
           AND date_trunc('month', po."createdAt") = m) AS committed,
      (SELECT COALESCE(SUM(i."totalAmount"), 0)::text FROM invoices i
         WHERE i."organizationId" = ${organizationId}::uuid
           AND i.status NOT IN ('REJECTED'::"InvoiceStatus", 'CANCELLED'::"InvoiceStatus")
           AND date_trunc('month', i."invoiceDate") = m) AS invoiced,
      (SELECT COALESCE(SUM(p."grossAmount"), 0)::text FROM payments p
         WHERE p."organizationId" = ${organizationId}::uuid
           AND p.status = 'COMPLETED'::"PaymentStatus"
           AND date_trunc('month', p."paidAt") = m) AS paid
    FROM generate_series(
      date_trunc('month', ${from}::timestamptz),
      date_trunc('month', ${to}::timestamptz),
      interval '1 month'
    ) AS m
    ORDER BY m`;
}

/** Committed, invoiced and paid for one slice, computed with SQL aggregates. */
async function slice(
  where: {
    po: Prisma.PurchaseOrderWhereInput;
    invoice: Prisma.InvoiceWhereInput;
    payment: Prisma.PaymentWhereInput;
  },
): Promise<{ orders: number; committed: Decimal; invoiced: Decimal; paid: Decimal }> {
  const [po, invoice, payment] = await Promise.all([
    prisma.purchaseOrder.aggregate({
      where: where.po,
      _sum: { totalAmount: true },
      _count: true,
    }),
    prisma.invoice.aggregate({ where: where.invoice, _sum: { totalAmount: true } }),
    prisma.payment.aggregate({ where: where.payment, _sum: { grossAmount: true } }),
  ]);

  return {
    orders: po._count,
    committed: money(po._sum.totalAmount ?? 0),
    invoiced: money(invoice._sum.totalAmount ?? 0),
    paid: money(payment._sum.grossAmount ?? 0),
  };
}

export async function spendReport(
  actor: Actor,
  query: SpendReportQuery,
): Promise<ReportResponse> {
  const scope = scopeToOrg(actor);
  const organizationId = scope.organizationId;
  const { from, to } = reportWindow(query);

  const rows: ReportRow[] = [];

  if (query.groupBy === 'month') {
    if (organizationId) {
      for (const row of await monthlySpend(organizationId, from, to)) {
        rows.push({
          month: row.month,
          orders: Number(row.orders),
          committed: toApi(money(row.committed)),
          invoiced: toApi(money(row.invoiced)),
          paid: toApi(money(row.paid)),
        });
      }
    }
  } else if (query.groupBy === 'vendor') {
    /*
     * Grouped in SQL, then one slice query per vendor on the page. Never
     * `findMany` five thousand orders and reduce them in Node (§1).
     */
    const grouped = await prisma.purchaseOrder.groupBy({
      by: ['vendorId'],
      where: {
        ...scope,
        status: { not: 'CANCELLED' },
        createdAt: { gte: from, lte: to },
      },
      _sum: { totalAmount: true },
      _count: true,
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: 50,
    });

    const vendors = await prisma.vendor.findMany({
      where: { id: { in: grouped.map((g) => g.vendorId) } },
      select: { id: true, companyName: true },
    });
    const nameOf = new Map(vendors.map((v) => [v.id, v.companyName]));

    for (const group of grouped) {
      const figures = await slice({
        po: { ...scope, vendorId: group.vendorId, status: { not: 'CANCELLED' }, createdAt: { gte: from, lte: to } },
        invoice: {
          ...scope,
          vendorId: group.vendorId,
          status: { notIn: ['REJECTED', 'CANCELLED'] },
          invoiceDate: { gte: from, lte: to },
        },
        payment: {
          ...scope,
          vendorId: group.vendorId,
          status: 'COMPLETED',
          paidAt: { gte: from, lte: to },
        },
      });

      rows.push({
        vendor: nameOf.get(group.vendorId) ?? group.vendorId,
        orders: figures.orders,
        committed: toApi(figures.committed),
        invoiced: toApi(figures.invoiced),
        paid: toApi(figures.paid),
      });
    }
  } else {
    // By category, which lives on the tender behind the order.
    const categories = await prisma.category.findMany({ select: { id: true, name: true } });

    for (const category of [...categories, { id: null, name: 'Uncategorised' }]) {
      const tenderFilter = category.id
        ? { categoryId: category.id }
        : { categoryId: null };

      const [tenders, figures] = await Promise.all([
        prisma.tender.count({
          where: { ...scope, ...tenderFilter, createdAt: { gte: from, lte: to } },
        }),
        slice({
          po: {
            ...scope,
            status: { not: 'CANCELLED' },
            createdAt: { gte: from, lte: to },
            tender: tenderFilter,
          },
          invoice: {
            ...scope,
            status: { notIn: ['REJECTED', 'CANCELLED'] },
            invoiceDate: { gte: from, lte: to },
            purchaseOrder: { tender: tenderFilter },
          },
          payment: {
            ...scope,
            status: 'COMPLETED',
            paidAt: { gte: from, lte: to },
            invoice: { purchaseOrder: { tender: tenderFilter } },
          },
        }),
      ]);

      // A category nobody bought from is noise on the page.
      if (tenders === 0 && figures.orders === 0) continue;

      rows.push({
        category: category.name,
        tenders,
        orders: figures.orders,
        committed: toApi(figures.committed),
        invoiced: toApi(figures.invoiced),
        paid: toApi(figures.paid),
      });
    }
  }

  const totalOf = (key: string) =>
    toApi(round2(sum(rows.map((row) => money((row[key] as string) ?? 0)))));

  const countOf = (key: string) =>
    rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);

  return {
    report: 'spend-analysis',
    params: {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      groupBy: query.groupBy,
    },
    columns: COLUMNS[query.groupBy]!,
    rows,
    totals: {
      ...(query.groupBy === 'category' ? { tenders: countOf('tenders') } : {}),
      orders: countOf('orders'),
      committed: rows.length === 0 ? toApi(ZERO) : totalOf('committed'),
      invoiced: rows.length === 0 ? toApi(ZERO) : totalOf('invoiced'),
      paid: rows.length === 0 ? toApi(ZERO) : totalOf('paid'),
    },
    meta: { generatedAt: new Date().toISOString(), rowCount: rows.length },
  };
}

export { monthlySpend };
