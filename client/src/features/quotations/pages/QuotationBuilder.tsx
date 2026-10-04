import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, Copy, Send, ShieldCheck } from 'lucide-react';
import type { QuotationDraftInput, QuotationVendorDto } from '@tb/shared';
import { cn } from '@/lib/cn';
import {
  addMoney,
  formatMoney,
  formatQty,
  multiplyQtyRate,
  subtractMoney,
  taxOnAmount,
  toMoneyString,
} from '@/lib/format';
import { useCountdown } from '@/hooks/useCountdown';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { Countdown } from '@/components/Countdown';
import { EmptyState } from '@/components/data/EmptyState';
import { FileUpload } from '@/components/form/FileUpload';
import { FormField, FormGrid } from '@/components/form/FormField';
import { MoneyInput } from '@/components/form/MoneyInput';
import { PageHeader } from '@/components/layout/PageHeader';
import { useMyQuotation, useSaveDraft, useSubmitQuotation } from '@/features/quotations/api';

/**
 * The quotation builder (plan 17 §5) — the vendor's most important screen.
 *
 * Three things it has to get right:
 *  - **The countdown.** Amber under 24 h, red under 1 h, and at zero the form
 *    disables itself and says "Bidding closed" without a page reload.
 *  - **Autosave**, two seconds after typing stops, with a visible "Draft saved"
 *    line. Vendors are nervous about losing work, and a lost bid is a lost
 *    contract.
 *  - **Totals recompute live for feedback and are recomputed server-side on
 *    submit** (plan 08 §4). Never trust the display value: every figure sent
 *    from here is ignored and derived again from quantity, price, discount and
 *    the tender's own tax rate.
 */

interface LineDraft {
  unitPrice: string;
  discountPercent: string;
  brandOrMake: string;
  remarks: string;
}

const AUTOSAVE_DELAY_MS = 2000;

export function QuotationBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const quotation = useMyQuotation(id);
  const saveDraft = useSaveDraft(id);
  const submit = useSubmitQuotation(id);

  const [lines, setLines] = useState<Record<string, LineDraft>>({});
  const [deliveryDays, setDeliveryDays] = useState('');
  const [validityDays, setValidityDays] = useState('');
  const [freightAmount, setFreightAmount] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');

  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [savedAgo, setSavedAgo] = useState<string>('');
  const [confirming, setConfirming] = useState(false);
  const [receipt, setReceipt] = useState<QuotationVendorDto | null>(null);

  const hydrated = useRef(false);
  const dirty = useRef(false);

  const data = quotation.data;
  const countdown = useCountdown(data?.bidSubmissionDeadline);
  const closed = countdown.expired;
  const editable = !!data && data.status === 'DRAFT' && !closed;

  /* ------------------------------ hydration ------------------------------ */

  useEffect(() => {
    if (!data || hydrated.current) return;
    hydrated.current = true;

    setLines(
      Object.fromEntries(
        data.items.map((item) => [
          item.tenderItemId,
          {
            // A zero price is the draft's placeholder, not a quote of nothing.
            unitPrice: Number(item.unitPrice) === 0 ? '' : item.unitPrice,
            discountPercent: Number(item.discountPercent) === 0 ? '' : item.discountPercent,
            brandOrMake: item.brandOrMake ?? '',
            remarks: item.remarks ?? '',
          },
        ]),
      ),
    );
    setDeliveryDays(data.deliveryDays ? String(data.deliveryDays) : '');
    setValidityDays(data.validityDays ? String(data.validityDays) : '');
    setFreightAmount(Number(data.freightAmount) === 0 ? '' : data.freightAmount);
    setPaymentTerms(data.paymentTerms ?? '');
    setNotes(data.notes ?? '');
  }, [data]);

  /* -------------------------------- totals ------------------------------- */

  const totals = useMemo(() => {
    let taxable = '0.00';
    let tax = '0.00';
    let gross = '0.00';

    for (const item of data?.items ?? []) {
      const draft = lines[item.tenderItemId];
      if (!draft?.unitPrice) continue;

      const lineGross = multiplyQtyRate(item.quantity, draft.unitPrice);
      const discount = draft.discountPercent
        ? taxOnAmount(lineGross, Number(draft.discountPercent))
        : '0.00';
      const lineTaxable = subtractMoney(lineGross, discount);

      gross = addMoney(gross, lineGross);
      taxable = addMoney(taxable, lineTaxable);
      tax = addMoney(tax, taxOnAmount(lineTaxable, Number(item.taxRatePercent)));
    }

    const freight = freightAmount ? toMoneyString(freightAmount) : '0.00';
    return {
      subtotal: gross,
      discount: subtractMoney(gross, taxable),
      taxable,
      tax,
      freight,
      grand: addMoney(taxable, tax, freight),
    };
  }, [data?.items, lines, freightAmount]);

  /* ------------------------------- autosave ------------------------------ */

  const payload = (): QuotationDraftInput => ({
    deliveryDays: deliveryDays ? Number(deliveryDays) : undefined,
    validityDays: validityDays ? Number(validityDays) : undefined,
    paymentTerms: paymentTerms.trim() || null,
    freightAmount: freightAmount ? toMoneyString(freightAmount) : '0.00',
    notes: notes.trim() || null,
    items: (data?.items ?? [])
      .filter((item) => !!lines[item.tenderItemId]?.unitPrice)
      .map((item) => {
        const draft = lines[item.tenderItemId] as LineDraft;
        return {
          tenderItemId: item.tenderItemId,
          quantity: item.quantity,
          unitPrice: toMoneyString(draft.unitPrice),
          discountPercent: draft.discountPercent
            ? Number(draft.discountPercent).toFixed(2)
            : '0.00',
          brandOrMake: draft.brandOrMake.trim() || undefined,
          remarks: draft.remarks.trim() || undefined,
        };
      }),
  });

  useEffect(() => {
    if (!editable || !hydrated.current || !dirty.current) return;

    const timer = setTimeout(() => {
      const body = payload();
      // The server requires at least one priced line; before that there is
      // nothing to save and saying "saving…" would be a lie.
      if ((body.items ?? []).length === 0) return;

      saveDraft.mutate(body, {
        onSuccess: () => {
          dirty.current = false;
          setSavedAt(new Date());
        },
        onError: (error) => toast.fromError(error),
      });
    }, AUTOSAVE_DELAY_MS);

    return () => clearTimeout(timer);
    // `payload` and the mutation are intentionally not dependencies: this effect
    // re-arms on every edit, and including them would restart the 2 s timer on
    // each render instead.
  }, [lines, deliveryDays, validityDays, freightAmount, paymentTerms, notes, editable]);

  // "Draft saved 12s ago" has to keep counting, or it reads as stale.
  useEffect(() => {
    if (!savedAt) return;
    const tick = () => {
      const seconds = Math.floor((Date.now() - savedAt.getTime()) / 1000);
      setSavedAgo(seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`);
    };
    tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, [savedAt]);

  const touch = () => {
    dirty.current = true;
  };

  const setLine = (tenderItemId: string, changes: Partial<LineDraft>) => {
    touch();
    setLines((current) => ({
      ...current,
      [tenderItemId]: {
        unitPrice: '',
        discountPercent: '',
        brandOrMake: '',
        remarks: '',
        ...(current[tenderItemId] ?? {}),
        ...changes,
      },
    }));
  };

  /* -------------------------------- render ------------------------------- */

  if (quotation.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!data) return <EmptyState title="Quotation not found" />;

  if (data.status !== 'DRAFT') {
    navigate(`/vendor/quotations/${data.id}`, { replace: true });
    return null;
  }

  const priced = (data.items ?? []).filter((item) => !!lines[item.tenderItemId]?.unitPrice).length;
  const canSubmit = editable && priced === data.items.length && !!deliveryDays && !!validityDays;

  return (
    <>
      <PageHeader
        title={data.tenderTitle}
        backTo={`/vendor/tenders/${data.tenderId}`}
        crumbs={[
          { label: 'My quotations', to: '/vendor/quotations' },
          { label: data.tenderReferenceNumber ?? 'Bid' },
        ]}
        meta={
          <>
            <span className="font-mono">{data.tenderReferenceNumber}</span>
            <Countdown deadline={data.bidSubmissionDeadline} label="Closes" />
            {savedAt && (
              <span className="inline-flex items-center gap-1 text-success">
                <Check aria-hidden className="size-3" />
                Draft saved {savedAgo}
              </span>
            )}
            {saveDraft.isPending && <span>Saving…</span>}
          </>
        }
        actions={
          <Button
            leftIcon={<Send className="size-3.5" />}
            disabled={!canSubmit}
            title={
              closed
                ? 'Bidding has closed.'
                : canSubmit
                  ? undefined
                  : 'Price every line and give delivery and validity days first.'
            }
            onClick={() => setConfirming(true)}
          >
            Submit quotation
          </Button>
        }
      />

      {closed && (
        <Card className="mb-4 border-danger/40 bg-danger/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">Bidding closed</p>
            <p className="text-xs text-muted">
              The deadline passed, so this draft can no longer be edited or submitted.
            </p>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Your prices"
              description="Quantities and tax rates come from the tender and cannot be changed."
            />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-subtle text-xs text-muted">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium">#</th>
                    <th className="px-2 py-2 text-left font-medium">Description</th>
                    <th className="px-2 py-2 text-right font-medium">Quantity</th>
                    <th className="w-36 px-2 py-2 text-right font-medium">Your rate</th>
                    <th className="w-24 px-2 py-2 text-right font-medium">Disc %</th>
                    <th className="px-2 py-2 text-right font-medium">Line total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.items.map((item) => {
                    const draft = lines[item.tenderItemId];
                    const lineGross = draft?.unitPrice
                      ? multiplyQtyRate(item.quantity, draft.unitPrice)
                      : '0.00';
                    const lineNet = draft?.discountPercent
                      ? subtractMoney(lineGross, taxOnAmount(lineGross, Number(draft.discountPercent)))
                      : lineGross;

                    return (
                      <tr key={item.tenderItemId} className="align-top">
                        <td className="px-2 py-2 font-mono text-xs tabular-nums text-muted">
                          {item.srNo ?? '—'}
                        </td>
                        <td className="px-2 py-2">
                          <p>{item.description ?? '—'}</p>
                          {editable && (
                            <Input
                              value={draft?.brandOrMake ?? ''}
                              placeholder="Brand or make (optional)"
                              className="mt-1 h-7 text-xs"
                              onChange={(event) =>
                                setLine(item.tenderItemId, { brandOrMake: event.target.value })
                              }
                            />
                          )}
                        </td>
                        <td className="numeric px-2 py-2">
                          {formatQty(item.quantity, item.unit)}
                          <span className="block text-xs text-muted">
                            GST {item.taxRatePercent}%
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <MoneyInput
                            value={draft?.unitPrice ?? ''}
                            disabled={!editable}
                            onChange={(value) => setLine(item.tenderItemId, { unitPrice: value })}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <Input
                            value={draft?.discountPercent ?? ''}
                            disabled={!editable}
                            inputMode="decimal"
                            placeholder="0"
                            className="text-right font-mono"
                            onChange={(event) =>
                              setLine(item.tenderItemId, {
                                discountPercent: event.target.value.replace(/[^\d.]/g, ''),
                              })
                            }
                          />
                        </td>
                        <td className="numeric px-2 py-3">{formatMoney(lineNet)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader title="Commercial terms" />
            <CardBody>
              <FormGrid columns={2}>
                <FormField label="Delivery days" required hint="From the purchase order date.">
                  <Input
                    value={deliveryDays}
                    disabled={!editable}
                    inputMode="numeric"
                    onChange={(event) => {
                      touch();
                      setDeliveryDays(event.target.value.replace(/\D/g, ''));
                    }}
                  />
                </FormField>

                <FormField label="Offer validity (days)" required hint="How long this price holds.">
                  <Input
                    value={validityDays}
                    disabled={!editable}
                    inputMode="numeric"
                    onChange={(event) => {
                      touch();
                      setValidityDays(event.target.value.replace(/\D/g, ''));
                    }}
                  />
                </FormField>

                <FormField label="Freight" hint="Charged on top of the line items.">
                  <MoneyInput
                    value={freightAmount}
                    disabled={!editable}
                    onChange={(value) => {
                      touch();
                      setFreightAmount(value);
                    }}
                  />
                </FormField>

                <FormField label="Payment terms">
                  <Input
                    value={paymentTerms}
                    disabled={!editable}
                    placeholder="30 days from invoice"
                    onChange={(event) => {
                      touch();
                      setPaymentTerms(event.target.value);
                    }}
                  />
                </FormField>

                <FormField label="Notes" className="sm:col-span-2">
                  <Textarea
                    rows={3}
                    value={notes}
                    disabled={!editable}
                    placeholder="Anything the buyer should know about this offer."
                    onChange={(event) => {
                      touch();
                      setNotes(event.target.value);
                    }}
                  />
                </FormField>
              </FormGrid>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Attachments"
              description="Datasheets, certificates, anything supporting your offer."
            />
            <CardBody>
              <FileUpload
                ownerType="QUOTATION"
                ownerId={data.id}
                type="QUOTATION_ATTACHMENT"
                disabled={!editable}
              />
            </CardBody>
          </Card>
        </div>

        <Card className="h-fit lg:sticky lg:top-4">
          <CardHeader title="Your offer" />
          <CardBody>
            <dl className="space-y-2 text-sm">
              {(
                [
                  { label: 'Subtotal', amount: totals.subtotal, negative: false },
                  { label: 'Discount', amount: totals.discount, negative: true },
                  { label: 'Taxable', amount: totals.taxable, negative: false },
                  { label: 'GST', amount: totals.tax, negative: false },
                  { label: 'Freight', amount: totals.freight, negative: false },
                ] as const
              ).map((row) => (
                <div key={row.label} className="flex justify-between">
                  <dt className="text-muted">{row.label}</dt>
                  <dd className="numeric">
                    {row.negative ? `−${formatMoney(row.amount)}` : formatMoney(row.amount)}
                  </dd>
                </div>
              ))}

              <div className="flex justify-between border-t border-border-strong pt-2 text-base font-semibold">
                <dt>Grand total</dt>
                <dd className="numeric">{formatMoney(totals.grand)}</dd>
              </div>
            </dl>

            <p className="mt-3 text-xs text-muted">
              These figures are for your feedback. The server recomputes every one of them when you
              submit, from the quantities and tax rates on the tender.
            </p>

            <div className="mt-4 border-t border-border pt-3">
              <p className="text-xs text-muted">
                {priced} of {data.items.length} lines priced
              </p>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className={cn(
                    'h-full rounded-full',
                    priced === data.items.length ? 'bg-success' : 'bg-warning',
                  )}
                  style={{ width: `${(priced / Math.max(1, data.items.length)) * 100}%` }}
                />
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Submit this quotation?"
        size="sm"
        dismissable={!submit.isPending}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={submit.isPending}>
              Keep editing
            </Button>
            <Button
              loading={submit.isPending}
              onClick={() =>
                submit.mutate(undefined, {
                  onSuccess: (result) => {
                    setConfirming(false);
                    setReceipt(result);
                  },
                  onError: (error) => toast.fromError(error),
                })
              }
            >
              Submit bid
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Once submitted, your bid is <strong>sealed</strong>. The buyer can see that you have bid,
          but not a single figure in it, until the deadline passes.
        </p>
        <p className="mt-2 text-sm text-muted">
          You can revise it while bidding is still open, but it cannot be changed after the deadline.
        </p>
        <div className="mt-4 flex justify-between rounded-md border border-border bg-subtle px-3 py-2 text-sm">
          <span>Grand total</span>
          <span className="numeric font-semibold">{formatMoney(totals.grand)}</span>
        </div>
      </Dialog>

      <Dialog
        open={!!receipt}
        onClose={() => {
          setReceipt(null);
          navigate(`/vendor/quotations/${data.id}`);
        }}
        title="Bid submitted"
        size="sm"
        footer={
          <Button
            onClick={() => {
              setReceipt(null);
              navigate(`/vendor/quotations/${data.id}`);
            }}
          >
            Done
          </Button>
        }
      >
        <div className="flex flex-col items-center py-2 text-center">
          <ShieldCheck aria-hidden className="mb-2 size-7 text-success" />
          <p className="text-sm font-medium">Your bid is sealed</p>
          <p className="mt-1 text-xs text-muted">
            Reference {receipt?.referenceNumber ?? '—'} · submitted{' '}
            {receipt?.submittedAt ? new Date(receipt.submittedAt).toLocaleString('en-IN') : ''}
          </p>
        </div>

        <div className="mt-3 rounded-md border border-border bg-subtle p-3">
          <p className="text-xs text-muted">Seal hash — your receipt</p>
          <p className="mt-1 font-mono text-xs break-all select-all">{receipt?.sealHash ?? '—'}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            leftIcon={<Copy className="size-3.5" />}
            onClick={() => {
              void navigator.clipboard
                .writeText(receipt?.sealHash ?? '')
                .then(() => toast.success('Seal hash copied'))
                .catch(() => toast.error('Could not copy', 'Select the text and copy it manually.'));
            }}
          >
            Copy hash
          </Button>
        </div>

        <p className="mt-3 text-xs text-muted">
          After the bids are opened, the buyer can recompute this hash from the stored rows. If it
          matches, nothing in your bid changed after you sealed it.
        </p>
      </Dialog>
    </>
  );
}
