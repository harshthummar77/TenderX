import type { Invoice, Tender } from '@prisma/client';
import type { PayableDto, PayableRowDto, TdsSuggestionDto } from '@tb/shared';
import { maskAccount, TDS_SECTIONS } from '@tb/shared';
import { round2, sum, toApi, ZERO, type Decimal } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import { outstandingOf, payableBlocker } from '../invoice/payable.js';

/**
 * The worklist an accounts person lives on (plan 13 §3), plus the TDS suggestion
 * that removes the most error-prone manual step on it.
 */

/**
 * Categories that read as services rather than supply. A tender for "network
 * installation services" is 194J; one for "managed switches" is 194C.
 *
 * Keyword matching is deliberately shallow and deliberately a *suggestion*: the
 * real test is the contract, which the system cannot read. Getting it wrong
 * costs the user one dropdown change; deducting automatically on a wrong guess
 * would cost them a tax correction.
 */
const SERVICE_KEYWORDS = [
  'service',
  'consult',
  'professional',
  'technical',
  'maintenance',
  'amc',
  'audit',
  'design',
  'training',
  'support',
];

const looksLikeService = (text: string): boolean => {
  const lower = text.toLowerCase();
  return SERVICE_KEYWORDS.some((keyword) => lower.includes(keyword));
};

/**
 * Suggest a TDS section and amount for what is still outstanding.
 *
 * Computed on the outstanding balance, not the invoice total, because that is
 * what the next payment will be for — suggesting tax on an amount the user is
 * not about to pay is worse than suggesting nothing.
 */
export function suggestTds(
  outstanding: Decimal,
  context: { categoryName?: string | null; tenderTitle?: string | null },
): TdsSuggestionDto | null {
  if (!outstanding.greaterThan(0)) return null;

  const haystack = `${context.categoryName ?? ''} ${context.tenderTitle ?? ''}`.trim();
  // With nothing to go on, 194C is the safer default: it is the lower rate, and
  // under-suggesting is corrected by the user rather than by the tax authority.
  const section = haystack && looksLikeService(haystack) ? '194J' : '194C';
  const percent = TDS_SECTIONS[section].percent;

  return {
    section,
    percent,
    amount: toApi(round2(outstanding.mul(percent).div(100))),
  };
}

type PayableInvoiceRow = Invoice & {
  vendor: {
    id: string;
    companyName: string;
    bankAccountNumber: string | null;
    bankIfsc: string | null;
  };
  purchaseOrder: {
    poNumber: string;
    status: string;
    tender: (Pick<Tender, 'title'> & { category: { name: string } | null }) | null;
  };
};

const daysBetween = (from: Date, to: Date): number =>
  Math.ceil((to.getTime() - from.getTime()) / 86_400_000);

export async function getPayable(actor: Actor, asOf: Date = new Date()): Promise<PayableDto> {
  const invoices = (await prisma.invoice.findMany({
    where: {
      ...scopeToOrg(actor),
      status: { in: ['APPROVED_FOR_PAYMENT', 'PARTIALLY_PAID'] },
    },
    include: {
      vendor: {
        select: { id: true, companyName: true, bankAccountNumber: true, bankIfsc: true },
      },
      purchaseOrder: {
        select: {
          poNumber: true,
          status: true,
          tender: { select: { title: true, category: { select: { name: true } } } },
        },
      },
    },
    // Oldest due first: that is the order somebody pays in.
    orderBy: { dueDate: 'asc' },
  })) as PayableInvoiceRow[];

  const rows: PayableRowDto[] = [];
  const outstandingAmounts: Decimal[] = [];
  const overdueAmounts: Decimal[] = [];

  for (const invoice of invoices) {
    const outstanding = outstandingOf(invoice);
    // A zero balance on a non-PAID invoice is a rounding artefact, not work.
    if (!outstanding.greaterThan(0)) continue;

    const daysToDue = daysBetween(asOf, invoice.dueDate);
    const isOverdue = daysToDue < 0;

    outstandingAmounts.push(outstanding);
    if (isOverdue) overdueAmounts.push(outstanding);

    rows.push({
      invoiceId: invoice.id,
      referenceNumber: invoice.referenceNumber,
      vendorInvoiceNumber: invoice.vendorInvoiceNumber,
      vendor: {
        id: invoice.vendor.id,
        name: invoice.vendor.companyName,
        // The last four digits are enough to recognise an account; the rest
        // never leaves the server (plan 06).
        bankMasked: maskAccount(invoice.vendor.bankAccountNumber),
      },
      poNumber: invoice.purchaseOrder?.poNumber ?? null,
      invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
      dueDate: invoice.dueDate.toISOString().slice(0, 10),
      daysToDue,
      totalAmount: toApi(invoice.totalAmount),
      amountPaid: toApi(invoice.amountPaid),
      outstanding: toApi(outstanding),
      suggestedTds: suggestTds(outstanding, {
        categoryName: invoice.purchaseOrder?.tender?.category?.name ?? null,
        tenderTitle: invoice.purchaseOrder?.tender?.title ?? null,
      }),
      matchStatus: invoice.matchStatus,
      isOverdue,
      // Listed but not payable: an officer should see why rather than guess.
      blockedReason: payableBlocker({
        ...invoice,
        purchaseOrder: { status: invoice.purchaseOrder?.status ?? 'ACCEPTED' },
      }),
    });
  }

  return {
    rows,
    totals: {
      count: rows.length,
      outstanding: toApi(round2(sum(outstandingAmounts))),
      overdue: toApi(round2(overdueAmounts.length === 0 ? ZERO : sum(overdueAmounts))),
    },
  };
}
