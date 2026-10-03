import type { ReportResponse } from '@tb/shared';

/**
 * One CSV exporter for all four reports (plan 15 §3).
 *
 * It works off the `columns` the report already declares, so adding a report
 * needs no change here — the column list travelling with the data is what makes
 * one exporter and one table component possible.
 */

/**
 * Excel right-aligns a column only when the field is unquoted and parses as a
 * number. Quoting a total would left-align it and stop it summing in the
 * spreadsheet, which defeats the point of exporting it.
 */
const NUMERIC = /^-?\d+(\.\d+)?$/;

const cell = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (NUMERIC.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
};

const line = (cells: (string | number | null | undefined)[]): string =>
  cells.map(cell).join(',');

/**
 * Excel reads a CSV as the local ANSI codepage unless the file opens with a
 * UTF-8 BOM, which mangles any non-ASCII vendor name.
 */
const BOM = '﻿';

/** CRLF: what every spreadsheet on Windows expects. */
const EOL = '\r\n';

export function reportToCsv(report: ReportResponse): string {
  const lines = [line(report.columns.map((column) => column.label))];

  for (const row of report.rows) {
    lines.push(line(report.columns.map((column) => row[column.key] ?? '')));
  }

  // A blank row, then the totals, labelled so the file stands alone.
  const hasTotals = Object.keys(report.totals).length > 0;
  if (hasTotals) {
    lines.push('');
    lines.push(
      line(
        report.columns.map((column, index) =>
          index === 0 ? 'Total' : (report.totals[column.key] ?? ''),
        ),
      ),
    );
  }

  lines.push('');
  lines.push(line(['Report', report.report]));
  for (const [key, value] of Object.entries(report.params)) {
    if (value !== undefined) lines.push(line([key, value]));
  }
  lines.push(line(['Generated at', report.meta.generatedAt]));
  lines.push(line(['Rows', report.meta.rowCount]));

  return BOM + lines.join(EOL) + EOL;
}

/** `spend-analysis-2025-04-01-to-2025-08-20.csv` — safe on every filesystem. */
export const reportFileName = (report: ReportResponse): string => {
  const window = [report.params.from, report.params.to].filter(Boolean).join('-to-');
  const stem = [report.report, window].filter(Boolean).join('-');
  return `${stem.replace(/[^A-Za-z0-9._-]/g, '-')}.csv`;
};
