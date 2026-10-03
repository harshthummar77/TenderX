import type { ReportColumn, ReportResponse, ReportRow, TenderReportQuery } from '@tb/shared';
import { money, round2, sum, toApi } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import { reportWindow } from './window.js';

/**
 * Tender summary (plan 15 §3) — what is in the pipeline, and how competitive
 * is it?
 *
 * The competitiveness columns are the point. A tender with one bid was not a
 * competition, and a tender whose lowest bid came in well under the estimate
 * says something about either the market or the estimate. Both are questions a
 * procurement manager actually asks, and neither is answerable from a status
 * count.
 */

const COLUMNS: ReportColumn[] = [
  { key: 'reference', label: 'Reference', type: 'string' },
  { key: 'title', label: 'Title', type: 'string' },
  { key: 'category', label: 'Category', type: 'string' },
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'publishedAt', label: 'Published', type: 'date' },
  { key: 'invited', label: 'Invited', type: 'number' },
  { key: 'bids', label: 'Bids', type: 'number' },
  { key: 'estimatedBudget', label: 'Estimate', type: 'money' },
  { key: 'lowestBid', label: 'Lowest bid', type: 'money' },
  { key: 'awardedValue', label: 'Awarded', type: 'money' },
  { key: 'savingPercent', label: 'Saving vs estimate %', type: 'percent' },
  { key: 'cycleDays', label: 'Cycle (days)', type: 'number' },
];

export async function tenderReport(
  actor: Actor,
  query: TenderReportQuery,
): Promise<ReportResponse> {
  const scope = scopeToOrg(actor);
  const { from, to } = reportWindow(query);

  const tenders = await prisma.tender.findMany({
    where: {
      ...scope,
      ...(query.status ? { status: query.status } : {}),
      createdAt: { gte: from, lte: to },
    },
    include: {
      category: { select: { name: true } },
      _count: { select: { invitations: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const rows: ReportRow[] = [];

  for (const tender of tenders) {
    /*
     * Only the live, latest bids count as competition. A withdrawn bid or a
     * superseded revision was never something the officer could have awarded.
     */
    const bids = await prisma.quotation.findMany({
      where: {
        tenderId: tender.id,
        isLatest: true,
        status: { notIn: ['DRAFT', 'WITHDRAWN'] },
      },
      select: { grandTotal: true, status: true },
      orderBy: { grandTotal: 'asc' },
    });

    const lowest = bids[0] ? money(bids[0].grandTotal) : null;
    const awarded = bids.find((bid) => bid.status === 'AWARDED');
    const estimate = tender.estimatedBudget === null ? null : money(tender.estimatedBudget);

    // Positive means it came in under the estimate, which is the good direction.
    const saving =
      estimate && !estimate.isZero() && lowest
        ? round2(estimate.minus(lowest).div(estimate).mul(100)).toNumber()
        : null;

    const cycleDays =
      tender.publishedAt && tender.awardedAt
        ? Math.round((tender.awardedAt.getTime() - tender.publishedAt.getTime()) / 86_400_000)
        : null;

    rows.push({
      reference: tender.referenceNumber || null,
      title: tender.title,
      category: tender.category?.name ?? 'Uncategorised',
      status: tender.status,
      publishedAt: tender.publishedAt?.toISOString().slice(0, 10) ?? null,
      invited: tender._count.invitations,
      bids: bids.length,
      estimatedBudget: estimate === null ? null : toApi(estimate),
      lowestBid: lowest === null ? null : toApi(lowest),
      awardedValue: awarded ? toApi(money(awarded.grandTotal)) : null,
      savingPercent: saving,
      cycleDays,
    });
  }

  const countOf = (key: string) =>
    rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);

  const moneyTotal = (key: string) =>
    toApi(round2(sum(rows.map((row) => money((row[key] as string) ?? 0)))));

  /** Averaged over the tenders that actually reached award. */
  const awardedRows = rows.filter((row) => row.cycleDays !== null);
  const avgCycle =
    awardedRows.length === 0
      ? null
      : Math.round(
          awardedRows.reduce((total, row) => total + Number(row.cycleDays), 0) /
            awardedRows.length,
        );

  return {
    report: 'tender-summary',
    params: {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      ...(query.status ? { status: query.status } : {}),
    },
    columns: COLUMNS,
    rows,
    totals: {
      invited: countOf('invited'),
      bids: countOf('bids'),
      estimatedBudget: moneyTotal('estimatedBudget'),
      awardedValue: moneyTotal('awardedValue'),
      cycleDays: avgCycle,
    },
    meta: { generatedAt: new Date().toISOString(), rowCount: rows.length },
  };
}
