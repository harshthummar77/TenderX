import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Receipt } from 'lucide-react';
import { PERMISSIONS as P, type CreateInvoiceInput } from '@tb/shared';
import {
  addMoney,
  formatMoney,
  formatQty,
  multiplyQtyRate,
  taxOnAmount,
  toMoneyString,
  toQtyString,
} from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/data/EmptyState';
import { DatePicker } from '@/components/form/DatePicker';
import { FormField, FormGrid } from '@/components/form/FormField';
import { MoneyInput } from '@/components/form/MoneyInput';
import { QuantityInput } from '@/components/form/QuantityInput';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { useCreateInvoice, useInvoiceable, useSubmitInvoice } from '@/features/invoices/api';

/**
 * `/vendor/invoices/new?poId=` — the invoice builder (plan 17 §1).
 *
 * Prefilled from `/invoiceable`, which is the server's answer to "what may this
 * vendor bill for": accepted minus already invoiced, per line. Billing more than
 * that is the quantity exception the three-way match exists to catch, and it
 * cannot be overridden later — so the form caps the inputs and says why.
 */
export function InvoiceBuilderPage() {
  const [searchParams] = useSearchParams();
  const params = useParams<{ poId?: string }>();
  const poId = params.poId ?? searchParams.get('poId') ?? undefined;

  const navigate = useNavigate();
  const { can } = useAuth();

  const invoiceable = useInvoiceable(poId);
  const createInvoice = useCreateInvoice(poId);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const submitInvoice = useSubmitInvoice(createdId ?? undefined);

  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState<string | null>(new Date().toISOString());
  const [freightAmount, setFreightAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!invoiceable.data || hydrated.current) return;
    hydrated.current = true;

    setQuantities(
      Object.fromEntries(
        invoiceable.data.lines.map((line) => [
          line.purchaseOrderItemId,
          Number(line.invoiceable) > 0 ? line.invoiceable : '',
        ]),
      ),
    );
    setPrices(
      Object.fromEntries(
        invoiceable.data.lines.map((line) => [line.purchaseOrderItemId, line.unitPrice]),
      ),
    );
  }, [invoiceable.data]);

  const lines = invoiceable.data?.lines ?? [];

  const totals = useMemo(() => {
    let taxable = '0.00';
    let tax = '0.00';

    for (const line of lines) {
      const quantity = quantities[line.purchaseOrderItemId];
      const price = prices[line.purchaseOrderItemId];
      if (!quantity || !price) continue;

      const lineTaxable = multiplyQtyRate(quantity, price);
      taxable = addMoney(taxable, lineTaxable);
      tax = addMoney(tax, taxOnAmount(lineTaxable, Number(line.taxRatePercent)));
    }

    const freight = freightAmount ? toMoneyString(freightAmount) : '0.00';
    return { taxable, tax, freight, total: addMoney(taxable, tax, freight) };
  }, [lines, quantities, prices, freightAmount]);

  const problems = useMemo(() => {
    const issues: string[] = [];
    if (vendorInvoiceNumber.trim().length === 0) issues.push('Give your invoice number.');
    if (!invoiceDate) issues.push('Give the invoice date.');

    let any = false;
    for (const line of lines) {
      const quantity = Number(quantities[line.purchaseOrderItemId] || 0);
      if (quantity <= 0) continue;
      any = true;

      if (quantity > Number(line.invoiceable) + 0.0005) {
        issues.push(
          `Line ${line.srNo}: you may bill at most ${formatQty(line.invoiceable)} — that is what has been accepted and not yet invoiced.`,
        );
      }
    }
    if (!any) issues.push('Put a quantity on at least one line.');

    return issues;
  }, [lines, quantities, vendorInvoiceNumber, invoiceDate]);

  if (!can(P.INVOICE_SUBMIT)) return <Forbidden />;

  if (!poId) {
    return (
      <EmptyState
        title="No purchase order selected"
        message="Open an accepted order and choose “Raise invoice”."
      />
    );
  }

  if (invoiceable.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!invoiceable.data) return <EmptyState title="Nothing to invoice" />;

  const { purchaseOrder, canInvoice, warnings } = invoiceable.data;

  if (!canInvoice) {
    return (
      <>
        <PageHeader
          title={`Raise invoice · ${purchaseOrder.poNumber}`}
          backTo={`/vendor/purchase-orders/${poId}`}
        />
        <Card>
          <EmptyState
            icon={<AlertTriangle className="size-5 text-warning" />}
            title="You cannot invoice this order yet"
            message={
              warnings[0] ??
              'The buyer has not accepted any goods against it. An invoice can only bill what has been received and accepted.'
            }
          />
        </Card>
      </>
    );
  }

  const submit = () => {
    const items: CreateInvoiceInput['items'] = lines
      .filter((line) => Number(quantities[line.purchaseOrderItemId] || 0) > 0)
      .map((line) => ({
        purchaseOrderItemId: line.purchaseOrderItemId,
        quantity: toQtyString(quantities[line.purchaseOrderItemId] as string),
        unitPrice: toMoneyString(prices[line.purchaseOrderItemId] as string),
        discountPercent: '0.00',
      }));

    createInvoice.mutate(
      {
        vendorInvoiceNumber: vendorInvoiceNumber.trim(),
        invoiceDate: invoiceDate as string,
        freightAmount: freightAmount ? toMoneyString(freightAmount) : '0.00',
        items,
      },
      {
        onSuccess: (invoice) => {
          setCreatedId(invoice.id);
          setConfirming(true);
        },
        onError: (error) => toast.fromError(error),
      },
    );
  };

  return (
    <>
      <PageHeader
        title={`Raise invoice · ${purchaseOrder.poNumber}`}
        backTo={`/vendor/purchase-orders/${poId}`}
        crumbs={[
          { label: 'My orders', to: '/vendor/purchase-orders' },
          { label: purchaseOrder.poNumber, to: `/vendor/purchase-orders/${poId}` },
          { label: 'Invoice' },
        ]}
        meta={<span>{purchaseOrder.taxRegime.replace('_', '-').toLowerCase()}</span>}
      />

      {warnings.length > 0 && (
        <Card className="mb-4 border-warning/40 bg-warning/5">
          <CardBody className="py-3">
            <ul className="space-y-1 text-xs">
              {warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-2">
                  <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  {warning}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <Card className="mb-4">
        <CardHeader title="Invoice header" />
        <CardBody>
          <FormGrid columns={3}>
            <FormField label="Your invoice number" required hint="Must be unique for your company.">
              <Input
                value={vendorInvoiceNumber}
                autoFocus
                placeholder="ACM/24-25/119"
                onChange={(event) => setVendorInvoiceNumber(event.target.value)}
              />
            </FormField>

            <FormField label="Invoice date" required>
              <DatePicker value={invoiceDate} onChange={setInvoiceDate} />
            </FormField>

            <FormField label="Freight">
              <MoneyInput value={freightAmount} onChange={setFreightAmount} />
            </FormField>
          </FormGrid>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Lines"
          description="Prefilled with what has been accepted and not yet billed."
        />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-subtle text-xs text-muted">
              <tr>
                <th className="px-2 py-2 text-left font-medium">#</th>
                <th className="px-2 py-2 text-left font-medium">Description</th>
                <th className="px-2 py-2 text-right font-medium">Accepted</th>
                <th className="px-2 py-2 text-right font-medium">Already billed</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Billing now</th>
                <th className="w-36 px-2 py-2 text-right font-medium">Rate</th>
                <th className="px-2 py-2 text-right font-medium">Line total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((line) => {
                const quantity = quantities[line.purchaseOrderItemId] ?? '';
                const price = prices[line.purchaseOrderItemId] ?? '';
                const over = Number(quantity || 0) > Number(line.invoiceable) + 0.0005;

                return (
                  <tr key={line.purchaseOrderItemId}>
                    <td className="px-2 py-2 font-mono text-xs tabular-nums text-muted">
                      {line.srNo}
                    </td>
                    <td className="px-2 py-2">
                      {line.description}
                      <span className="block font-mono text-xs text-muted">
                        {line.hsnCode ?? 'no HSN'} · GST {line.taxRatePercent}%
                      </span>
                    </td>
                    <td className="numeric px-2 py-2">{formatQty(line.accepted, line.unit)}</td>
                    <td className="numeric px-2 py-2 text-muted">
                      {formatQty(line.alreadyInvoiced)}
                      <span className="block text-xs">{formatQty(line.invoiceable)} billable</span>
                    </td>
                    <td className="px-2 py-2">
                      <QuantityInput
                        value={quantity}
                        unit={line.unit}
                        invalid={over}
                        onChange={(value) =>
                          setQuantities((current) => ({
                            ...current,
                            [line.purchaseOrderItemId]: value,
                          }))
                        }
                      />
                    </td>
                    <td className="px-2 py-2">
                      <MoneyInput
                        value={price}
                        onChange={(value) =>
                          setPrices((current) => ({
                            ...current,
                            [line.purchaseOrderItemId]: value,
                          }))
                        }
                      />
                    </td>
                    <td className="numeric px-2 py-3">
                      {formatMoney(quantity && price ? multiplyQtyRate(quantity, price) : '0.00')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <CardBody className="border-t border-border">
          <dl className="ml-auto max-w-sm space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Taxable</dt>
              <dd className="numeric">{formatMoney(totals.taxable)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">GST</dt>
              <dd className="numeric">{formatMoney(totals.tax)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Freight</dt>
              <dd className="numeric">{formatMoney(totals.freight)}</dd>
            </div>
            <div className="flex justify-between border-t border-border-strong pt-2 font-semibold">
              <dt>Total</dt>
              <dd className="numeric">{formatMoney(totals.total)}</dd>
            </div>
          </dl>

          <p className="mt-2 text-right text-xs text-muted">
            The server recomputes every figure, including the tax split, from the order's place of
            supply.
          </p>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            {problems.length > 0 ? (
              <p className="text-xs text-danger">{problems[0]}</p>
            ) : (
              <p className="text-xs text-muted">
                Creating the invoice saves it as a draft; submitting it runs the three-way match.
              </p>
            )}

            <Button
              leftIcon={<Receipt className="size-3.5" />}
              disabled={problems.length > 0}
              loading={createInvoice.isPending}
              onClick={submit}
            >
              Create invoice
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          if (createdId) navigate(`/vendor/invoices/${createdId}`);
        }}
        title="Submit this invoice to the buyer?"
        message="Submitting runs the three-way match against the purchase order and the goods receipt. If anything fails, the buyer sees exactly which line and why."
        confirmLabel="Submit invoice"
        cancelLabel="Keep as draft"
        requireReason={false}
        destructive={false}
        loading={submitInvoice.isPending}
        onConfirm={() =>
          submitInvoice.mutate(undefined, {
            onSuccess: (invoice) => {
              toast.success(
                'Invoice submitted',
                invoice.matchStatus === 'EXCEPTION'
                  ? 'The match found an exception — the buyer will review it.'
                  : 'The three-way match passed.',
              );
              setConfirming(false);
              navigate(`/vendor/invoices/${invoice.id}`);
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />
    </>
  );
}
