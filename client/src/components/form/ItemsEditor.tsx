import { useMemo, type ClipboardEvent } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { TAX_RATES, UNITS } from '@tb/shared';
import { cn } from '@/lib/cn';
import {
  addMoney,
  formatMoney,
  multiplyQtyRate,
  sanitizeMoneyInput,
  sanitizeQtyInput,
  taxOnAmount,
} from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { MoneyInput } from '@/components/form/MoneyInput';
import { QuantityInput } from '@/components/form/QuantityInput';

/**
 * The editable line-item grid — the highest-leverage component in the app
 * (plan 16 §5). Tender items, quotation lines, PO lines, GRN receipts and
 * invoice lines are all this component with different columns switched on.
 *
 * **Paste-from-Excel is the feature that matters.** Procurement people live in
 * spreadsheets: a tender with 40 items is pasted, not typed. Pasting a block
 * splits on tab and newline, fills across the visible columns from wherever the
 * caret is, and grows the grid to fit — so a 40-row tender takes one Ctrl+V
 * instead of 200 keystrokes.
 *
 * Every figure is a string, and the footer totals use the BigInt helpers in
 * `lib/format`, so the total the user reads is the total the server computes.
 */

export interface EditableItem {
  /** Client-side row identity. Stable across reorders, unlike the array index. */
  key: string;
  description: string;
  hsnSac: string;
  unit: string;
  quantity: string;
  rate: string;
  taxRate: number;
}

type PasteableField = 'description' | 'hsnSac' | 'unit' | 'quantity' | 'rate' | 'taxRate';

export interface ItemsEditorProps {
  items: EditableItem[];
  onChange: (items: EditableItem[]) => void;
  /** Tender items have no prices — the whole point is that vendors supply them. */
  showRate?: boolean;
  showTax?: boolean;
  showHsn?: boolean;
  disabled?: boolean;
  maxRows?: number;
  /** `{ '0.rate': 'Required' }`, keyed by row index then field — matches the server's paths. */
  errors?: Record<string, string>;
  className?: string;
}

let fallbackId = 0;
const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `row-${++fallbackId}`;

export const emptyItem = (): EditableItem => ({
  key: newKey(),
  description: '',
  hsnSac: '',
  unit: 'NOS',
  quantity: '',
  rate: '',
  taxRate: 18,
});

const UNIT_OPTIONS = UNITS.map((unit) => ({ value: unit, label: unit }));
const TAX_OPTIONS = TAX_RATES.map((rate) => ({ value: String(rate), label: `${rate}%` }));

/** Row amount, rounded once: quantity (3 dp) × rate (2 dp). */
export const lineAmount = (item: EditableItem) =>
  item.quantity && item.rate ? multiplyQtyRate(item.quantity, item.rate) : '0.00';

export function ItemsEditor({
  items,
  onChange,
  showRate = true,
  showTax = true,
  showHsn = true,
  disabled = false,
  maxRows = 200,
  errors = {},
  className,
}: ItemsEditorProps) {
  /** Column order drives the paste mapping, so it is derived once, here. */
  const pasteFields = useMemo(() => {
    const fields: PasteableField[] = ['description'];
    if (showHsn) fields.push('hsnSac');
    fields.push('unit', 'quantity');
    if (showRate) fields.push('rate');
    if (showTax && showRate) fields.push('taxRate');
    return fields;
  }, [showHsn, showRate, showTax]);

  const totals = useMemo(() => {
    let subtotal = '0.00';
    let tax = '0.00';
    for (const item of items) {
      const amount = lineAmount(item);
      subtotal = addMoney(subtotal, amount);
      if (showTax) tax = addMoney(tax, taxOnAmount(amount, item.taxRate));
    }
    return { subtotal, tax, total: addMoney(subtotal, showTax ? tax : '0.00') };
  }, [items, showTax]);

  const patch = (index: number, changes: Partial<EditableItem>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...changes } : item)));
  };

  const addRow = () => {
    if (items.length >= maxRows) return;
    onChange([...items, emptyItem()]);
  };

  const removeRow = (index: number) => onChange(items.filter((_, i) => i !== index));

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row as EditableItem);
    onChange(next);
  };

  /** Coerce a pasted cell into the shape its column expects. */
  const coerce = (field: PasteableField, raw: string): Partial<EditableItem> => {
    const value = raw.trim();
    switch (field) {
      case 'quantity':
        return { quantity: sanitizeQtyInput(value) };
      case 'rate':
        return { rate: sanitizeMoneyInput(value) };
      case 'taxRate': {
        const parsed = Number(value.replace('%', '').trim());
        const allowed = TAX_RATES.find((rate) => rate === parsed);
        return allowed === undefined ? {} : { taxRate: allowed };
      }
      case 'unit': {
        const upper = value.toUpperCase();
        return UNITS.includes(upper as (typeof UNITS)[number]) ? { unit: upper } : {};
      }
      default:
        return { [field]: value } as Partial<EditableItem>;
    }
  };

  /**
   * A single cell's worth of text pastes normally. A block (anything with a tab
   * or a newline) is treated as a grid anchored at the cell being pasted into.
   */
  const handlePaste = (
    event: ClipboardEvent<HTMLElement>,
    rowIndex: number,
    field: PasteableField,
  ) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text || !/[\t\n\r]/.test(text)) return;

    event.preventDefault();

    const grid = text
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/, '')
      .split('\n')
      .map((line) => line.split('\t'));

    const startColumn = pasteFields.indexOf(field);
    const next = [...items];

    grid.forEach((cells, offset) => {
      const targetIndex = rowIndex + offset;
      if (targetIndex >= maxRows) return;
      // Excel pastes are usually longer than the grid — grow it rather than
      // silently dropping the tail.
      if (!next[targetIndex]) next[targetIndex] = emptyItem();

      let row = next[targetIndex] as EditableItem;
      cells.forEach((cell, cellOffset) => {
        const targetField = pasteFields[startColumn + cellOffset];
        if (!targetField) return;
        row = { ...row, ...coerce(targetField, cell) };
      });
      next[targetIndex] = row;
    });

    onChange(next);
  };

  const errorFor = (index: number, field: string) => errors[`${index}.${field}`];

  const columnCount = 3 + (showHsn ? 1 : 0) + (showRate ? 2 : 0) + (showTax && showRate ? 1 : 0);

  return (
    <div className={cn('rounded-lg border border-border bg-surface', className)}>
      <div className="w-full overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-subtle text-xs text-muted">
            <tr>
              <th scope="col" className="w-8 px-2 py-2 text-left font-medium">
                #
              </th>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                Description
              </th>
              {showHsn && (
                <th scope="col" className="w-28 px-2 py-2 text-left font-medium">
                  HSN / SAC
                </th>
              )}
              <th scope="col" className="w-24 px-2 py-2 text-left font-medium">
                Unit
              </th>
              <th scope="col" className="w-32 px-2 py-2 text-right font-medium">
                Quantity
              </th>
              {showRate && (
                <th scope="col" className="w-36 px-2 py-2 text-right font-medium">
                  Rate
                </th>
              )}
              {showTax && showRate && (
                <th scope="col" className="w-24 px-2 py-2 text-right font-medium">
                  GST
                </th>
              )}
              {showRate && (
                <th scope="col" className="w-36 px-2 py-2 text-right font-medium">
                  Amount
                </th>
              )}
              <th scope="col" className="w-24 px-2 py-2">
                <span className="sr-only">Row actions</span>
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-border">
            {items.length === 0 && (
              <tr>
                <td colSpan={columnCount + 2} className="px-3 py-8 text-center text-xs text-muted">
                  No items yet. Add a row, or paste a block of cells from a spreadsheet.
                </td>
              </tr>
            )}

            {items.map((item, index) => (
              <tr key={item.key} className="align-top">
                <td className="px-2 py-1.5 font-mono text-xs tabular-nums text-muted">{index + 1}</td>

                <td className="px-2 py-1.5">
                  <Input
                    value={item.description}
                    disabled={disabled}
                    placeholder="Item description"
                    invalid={!!errorFor(index, 'description')}
                    onChange={(event) => patch(index, { description: event.target.value })}
                    onPaste={(event) => handlePaste(event, index, 'description')}
                  />
                  {errorFor(index, 'description') && (
                    <p className="mt-1 text-xs text-danger">{errorFor(index, 'description')}</p>
                  )}
                </td>

                {showHsn && (
                  <td className="px-2 py-1.5">
                    <Input
                      value={item.hsnSac}
                      disabled={disabled}
                      inputMode="numeric"
                      placeholder="8471"
                      invalid={!!errorFor(index, 'hsnSac')}
                      onChange={(event) => patch(index, { hsnSac: event.target.value })}
                      onPaste={(event) => handlePaste(event, index, 'hsnSac')}
                      className="font-mono"
                    />
                  </td>
                )}

                <td className="px-2 py-1.5">
                  <Select
                    value={item.unit}
                    disabled={disabled}
                    options={UNIT_OPTIONS}
                    invalid={!!errorFor(index, 'unit')}
                    onChange={(event) => patch(index, { unit: event.target.value })}
                  />
                </td>

                <td className="px-2 py-1.5">
                  <QuantityInput
                    value={item.quantity}
                    disabled={disabled}
                    invalid={!!errorFor(index, 'quantity')}
                    onChange={(quantity) => patch(index, { quantity })}
                    onPaste={(event) => handlePaste(event, index, 'quantity')}
                  />
                  {errorFor(index, 'quantity') && (
                    <p className="mt-1 text-xs text-danger">{errorFor(index, 'quantity')}</p>
                  )}
                </td>

                {showRate && (
                  <td className="px-2 py-1.5">
                    <MoneyInput
                      value={item.rate}
                      disabled={disabled}
                      invalid={!!errorFor(index, 'rate')}
                      onChange={(rate) => patch(index, { rate })}
                      onPaste={(event) => handlePaste(event, index, 'rate')}
                    />
                    {errorFor(index, 'rate') && (
                      <p className="mt-1 text-xs text-danger">{errorFor(index, 'rate')}</p>
                    )}
                  </td>
                )}

                {showTax && showRate && (
                  <td className="px-2 py-1.5">
                    <Select
                      value={String(item.taxRate)}
                      disabled={disabled}
                      options={TAX_OPTIONS}
                      onChange={(event) => patch(index, { taxRate: Number(event.target.value) })}
                    />
                  </td>
                )}

                {showRate && (
                  <td className="px-2 py-3 numeric text-sm">{formatMoney(lineAmount(item))}</td>
                )}

                <td className="px-2 py-1.5">
                  <div className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Move row ${index + 1} up`}
                      disabled={disabled || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ChevronUp className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Move row ${index + 1} down`}
                      disabled={disabled || index === items.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Remove row ${index + 1}`}
                      disabled={disabled}
                      onClick={() => removeRow(index)}
                    >
                      <Trash2 className="size-3.5 text-danger" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>

          {showRate && items.length > 0 && (
            <tfoot className="border-t-2 border-border-strong bg-subtle">
              <tr>
                <td colSpan={columnCount} className="px-2 py-1.5 text-right text-xs text-muted">
                  Subtotal
                </td>
                <td className="px-2 py-1.5 numeric text-sm">{formatMoney(totals.subtotal)}</td>
                <td />
              </tr>
              {showTax && (
                <tr>
                  <td colSpan={columnCount} className="px-2 py-1.5 text-right text-xs text-muted">
                    GST
                  </td>
                  <td className="px-2 py-1.5 numeric text-sm">{formatMoney(totals.tax)}</td>
                  <td />
                </tr>
              )}
              <tr>
                <td colSpan={columnCount} className="px-2 py-2 text-right text-xs font-semibold">
                  Total
                </td>
                <td className="px-2 py-2 numeric text-sm font-semibold">
                  {formatMoney(totals.total)}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || items.length >= maxRows}
          onClick={addRow}
          leftIcon={<Plus className="size-3.5" />}
        >
          Add row
        </Button>
        <p className="text-xs text-muted">
          Paste a block from Excel into any cell — tab-separated columns, one line per row.
        </p>
      </div>
    </div>
  );
}
