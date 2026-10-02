import type { ComparisonDto } from '@tb/shared';

/**
 * The comparison as CSV (09 §8) — the artefact a real procurement officer
 * attaches to the approval note. XLSX was cut (00 §3); this is thirty lines and
 * opens in the same spreadsheet.
 */

/**
 * Excel decides a column is a number — and therefore right-aligns it — only
 * when the field is unquoted and parses as one. So money and scores go out
 * bare, and text is quoted. Quoting a total would left-align it and stop it
 * summing in the spreadsheet, which defeats the point of exporting it.
 */
const NUMERIC = /^-?\d+(\.\d+)?$/;

const cell = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (NUMERIC.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
};

const row = (cells: (string | number | null | undefined)[]): string =>
  cells.map(cell).join(',');

/**
 * Excel reads a CSV as the local ANSI codepage unless the file opens with a
 * UTF-8 BOM. Without it, a vendor named "Saraf & Söhne" arrives mangled — and
 * the officer's first impression of the system is a broken character.
 */
const BOM = '﻿';

/** CRLF: the line ending every spreadsheet on Windows expects. */
const EOL = '\r\n';

export function comparisonToCsv(comparison: ComparisonDto): string {
  const { tender, items, bids, summary } = comparison;

  const header = [
    'Rank',
    'Vendor',
    'Quotation',
    'Rating',
    'New vendor',
    ...items.map((item) => `${item.srNo}. ${item.description} (${item.unit} ${item.quantity})`),
    'Grand total',
    'Delivery days',
    'Validity days',
    'Price score',
    'Technical score',
    'Total score',
    'Flags',
    'Deviations',
  ];

  const lines = [row(header)];

  for (const bid of bids) {
    const byItem = new Map(bid.lines.map((line) => [line.tenderItemId, line]));
    lines.push(
      row([
        bid.rank,
        bid.vendor.name,
        bid.referenceNumber,
        bid.vendor.rating,
        bid.vendor.isNew ? 'Yes' : 'No',
        ...items.map((item) => byItem.get(item.tenderItemId)?.lineTotal ?? ''),
        bid.grandTotal,
        bid.deliveryDays,
        bid.validityDays,
        bid.priceScore,
        bid.technicalScore,
        bid.totalScore,
        bid.flags.join('; '),
        bid.deviations.join('; '),
      ]),
    );
  }

  // A blank row, then the figures the approval note quotes.
  lines.push('');
  lines.push(row(['Tender', tender.referenceNumber ?? tender.id, tender.title]));
  lines.push(row(['Evaluation method', tender.evaluationMethod]));
  lines.push(row(['Bids compared', summary.bidCount]));
  lines.push(row(['Lowest total', summary.lowestTotal]));
  lines.push(row(['Highest total', summary.highestTotal]));
  lines.push(row(['Average total', summary.averageTotal]));
  lines.push(row(['Spread %', summary.spreadPercent]));
  if (tender.estimatedBudget) {
    lines.push(row(['Estimated budget', tender.estimatedBudget]));
  }
  if (summary.budgetVariance) {
    lines.push(row(['Budget variance', summary.budgetVariance.amount]));
    lines.push(row(['Budget variance %', summary.budgetVariance.percent]));
  }

  return BOM + lines.join(EOL) + EOL;
}

/** `TND-2025-26-000012-comparison.csv` — safe on every filesystem. */
export const comparisonFileName = (comparison: ComparisonDto): string => {
  const stem = (comparison.tender.referenceNumber ?? comparison.tender.id).replace(
    /[^A-Za-z0-9._-]/g,
    '-',
  );
  return `${stem}-comparison.csv`;
};
