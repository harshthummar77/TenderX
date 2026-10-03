import type { RowData } from '@tanstack/react-table';

/**
 * Column metadata every table in the app can rely on.
 *
 * `numeric: true` is the money typography rule (plan 16 §4) expressed once: the
 * header and every cell in that column get `font-mono tabular-nums text-right`,
 * so a screen cannot forget it on one column out of six and leave the digits
 * failing to line up.
 */
declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Money and quantity columns. */
    numeric?: boolean;
    className?: string;
    headerClassName?: string;
    /** Keep out of the column-visibility menu (an id column, a row-action column). */
    alwaysVisible?: boolean;
    /** Label shown in the column-visibility menu when the header is not a string. */
    label?: string;
  }
}

export type {};
