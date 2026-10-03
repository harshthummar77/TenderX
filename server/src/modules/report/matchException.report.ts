import type { ReportColumn, ReportQuery, ReportResponse, ReportRow } from '@tb/shared';
import { money, round2, sum, toApi } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { MatchCheck } from '../invoice/match.engine.js';
import { reportWindow } from './window.js';

/**
 * Match exceptions (plan 15 §3) — which invoices failed verification, and who
 * overrode them?
 *
 * **This is the report worth showing an examiner.** It is an internal-audit
 * artefact: every invoice that failed the three-way match, exactly what failed,
 * whether somebody waved it through, who that was, and the reason they gave. The
 * override is legitimate — a ₹40 difference on an ₹8 lakh order should not stall
 * a payment — but it is attributable, and this is where the attribution surfaces.
 *
 * It reads the stored `matchResult` checklist rather than re-running the engine,
 * because the question is what the match said *at the time*, not what it would
 * say now against quantities that have since moved.
 */

const COLUMNS: ReportColumn[] = [
  { key: 'invoice', label: 'Invoice', type: 'string' },
  { key: 'vendor', label: 'Vendor', type: 'string' },
  { key: 'poNumber', label: 'Purchase order', type: 'string' },
  { key: 'invoiceDate', label: 'Invoice date', type: 'date' },
  { key: 'amount', label: 'Amount', type: 'money' },
  { key: 'matchStatus', label: 'Match status', type: 'string' },
  { key: 'failedChecks', label: 'Failed checks', type: 'string' },
  { key: 'variance', label: 'Variance', type: 'string' },
  { key: 'overriddenBy', label: 'Overridden by', type: 'string' },
  { key: 'overrideReason', label: 'Override reason', type: 'string' },
  { key: 'status', label: 'Invoice status', type: 'string' },
];

const checksOf = (matchResult: unknown): MatchCheck[] =>
  Array.isArray(matchResult) ? (matchResult as unknown as MatchCheck[]) : [];

export async function matchExceptionReport(
  actor: Actor,
  query: ReportQuery,
): Promise<ReportResponse> {
  const scope = scopeToOrg(actor);
  const { from, to } = reportWindow(query);

  const invoices = await prisma.invoice.findMany({
    where: {
      ...scope,
      // Both: an open exception is a thing to fix, an override is a thing to review.
      matchStatus: { in: ['EXCEPTION', 'OVERRIDDEN'] },
      invoiceDate: { gte: from, lte: to },
    },
    include: {
      vendor: { select: { companyName: true } },
      purchaseOrder: { select: { poNumber: true } },
    },
    orderBy: { invoiceDate: 'desc' },
  });

  // Resolve the overriding admins in one query rather than per row.
  const overriderIds = [
    ...new Set(invoices.map((invoice) => invoice.overriddenById).filter((id): id is string => !!id)),
  ];
  const overriders = await prisma.user.findMany({
    where: { id: { in: overriderIds } },
    select: { id: true, fullName: true, email: true },
  });
  const overriderOf = new Map(
    overriders.map((user) => [user.id, `${user.fullName} <${user.email}>`]),
  );

  const rows: ReportRow[] = invoices.map((invoice) => {
    const failures = checksOf(invoice.matchResult).filter((check) => check.status === 'FAIL');

    return {
      invoice: invoice.vendorInvoiceNumber,
      vendor: invoice.vendor.companyName,
      poNumber: invoice.purchaseOrder?.poNumber ?? null,
      invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
      amount: toApi(invoice.totalAmount),
      matchStatus: invoice.matchStatus,
      failedChecks: failures.map((check) => check.label).join('; ') || null,
      // The numbers behind the verdict, so the row stands alone in a CSV.
      variance:
        failures
          .filter((check) => check.expected !== undefined || check.actual !== undefined)
          .map(
            (check) =>
              `${check.code}: expected ${check.expected ?? '-'}, actual ${check.actual ?? '-'}${
                check.variance ? ` (${check.variance})` : ''
              }`,
          )
          .join('; ') || null,
      overriddenBy: invoice.overriddenById
        ? (overriderOf.get(invoice.overriddenById) ?? invoice.overriddenById)
        : null,
      overrideReason: invoice.overrideReason,
      status: invoice.status,
    };
  });

  const overridden = rows.filter((row) => row.matchStatus === 'OVERRIDDEN').length;
  const open = rows.filter((row) => row.matchStatus === 'EXCEPTION').length;

  return {
    report: 'match-exceptions',
    params: {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    },
    columns: COLUMNS,
    rows,
    totals: {
      amount: toApi(round2(sum(rows.map((row) => money((row.amount as string) ?? 0))))),
      // Two counts rather than one: they mean very different things.
      matchStatus: `${open} open, ${overridden} overridden`,
    },
    meta: { generatedAt: new Date().toISOString(), rowCount: rows.length },
  };
}
