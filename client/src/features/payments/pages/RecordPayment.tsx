import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import {
  BANK_METHODS,
  PAYMENT_METHODS,
  PERMISSIONS as P,
  TDS_SECTIONS,
  type CreatePaymentInput,
} from '@tb/shared';
import { addMoney, formatDate, formatMoney, subtractMoney, toMoneyString } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/data/EmptyState';
import { DatePicker } from '@/components/form/DatePicker';
import { FormField, FormGrid } from '@/components/form/FormField';
import { MoneyInput } from '@/components/form/MoneyInput';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { useInvoice } from '@/features/invoices/api';
import { useCreatePayment, usePayable } from '@/features/payments/api';

/**
 * `/payments/new?invoiceId=` — record a payment (plan 13).
 *
 * The deductions are the part worth care: TDS, retention and other deductions
 * come off the gross, and the net is what the bank is told to send. The suggested
 * TDS section comes from the payables worklist, but the figure stays editable —
 * the system suggests, the admin decides, and the audit row records both.
 */
export function RecordPaymentPage() {
  const [searchParams] = useSearchParams();
  const invoiceId = searchParams.get('invoiceId') ?? undefined;
  const navigate = useNavigate();
  const { can } = useAuth();

  const invoice = useInvoice('buyer', invoiceId);
  const payable = usePayable();
  const createPayment = useCreatePayment();

  const [grossAmount, setGrossAmount] = useState('');
  const [tdsAmount, setTdsAmount] = useState('');
  const [tdsSection, setTdsSection] = useState('');
  const [retentionAmount, setRetentionAmount] = useState('');
  const [otherDeduction, setOtherDeduction] = useState('');
  const [method, setMethod] = useState<string>('NEFT');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [paidAt, setPaidAt] = useState<string | null>(new Date().toISOString());
  const [remarks, setRemarks] = useState('');
  const [confirming, setConfirming] = useState(false);

  const row = payable.data?.rows.find((entry) => entry.invoiceId === invoiceId);

  // Prefill from the worklist: the full outstanding balance and the suggested TDS.
  useEffect(() => {
    if (!invoice.data || grossAmount) return;
    setGrossAmount(invoice.data.outstanding);
  }, [invoice.data, grossAmount]);

  useEffect(() => {
    if (!row?.suggestedTds || tdsAmount) return;
    setTdsAmount(row.suggestedTds.amount);
    setTdsSection(row.suggestedTds.section);
  }, [row, tdsAmount]);

  const net = useMemo(() => {
    const deductions = addMoney(
      tdsAmount || '0.00',
      retentionAmount || '0.00',
      otherDeduction || '0.00',
    );
    return subtractMoney(grossAmount || '0.00', deductions);
  }, [grossAmount, tdsAmount, retentionAmount, otherDeduction]);

  const problems = useMemo(() => {
    const issues: string[] = [];
    if (!invoiceId) issues.push('Choose an invoice from the payables worklist.');
    if (!grossAmount || Number(grossAmount) <= 0) issues.push('Give the gross amount.');
    if (invoice.data && Number(grossAmount || 0) > Number(invoice.data.outstanding) + 0.005) {
      issues.push(
        `The gross amount cannot exceed the ${formatMoney(invoice.data.outstanding)} still outstanding.`,
      );
    }
    if (Number(net) <= 0) issues.push('Deductions cannot be more than the gross amount.');
    if (tdsAmount && Number(tdsAmount) > 0 && !tdsSection) issues.push('Pick the TDS section.');
    if (!paidAt) issues.push('Give the payment date.');
    return issues;
  }, [invoiceId, grossAmount, invoice.data, net, tdsAmount, tdsSection, paidAt]);

  if (!can(P.PAYMENT_RECORD)) return <Forbidden />;

  if (!invoiceId) {
    return (
      <EmptyState
        title="No invoice selected"
        message="Open the payables worklist and choose an invoice to pay."
      />
    );
  }

  if (invoice.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!invoice.data) return <EmptyState title="Invoice not found" />;

  const data = invoice.data;

  const submit = () => {
    const input: CreatePaymentInput = {
      invoiceId,
      grossAmount: toMoneyString(grossAmount),
      tdsAmount: tdsAmount ? toMoneyString(tdsAmount) : '0.00',
      tdsSection: tdsSection ? (tdsSection as CreatePaymentInput['tdsSection']) : undefined,
      retentionAmount: retentionAmount ? toMoneyString(retentionAmount) : '0.00',
      otherDeduction: otherDeduction ? toMoneyString(otherDeduction) : '0.00',
      method: method as CreatePaymentInput['method'],
      referenceNumber: referenceNumber.trim() || undefined,
      paidAt: paidAt as string,
      remarks: remarks.trim() || undefined,
    };

    createPayment.mutate(input, {
      onSuccess: (payment) => {
        toast.success(
          `Payment ${payment.paymentNumber} recorded`,
          payment.status === 'PENDING_APPROVAL'
            ? 'It is above the threshold, so a second administrator has to authorise it.'
            : undefined,
        );
        setConfirming(false);
        navigate(`/payments/${payment.id}`);
      },
      onError: (error) => {
        setConfirming(false);
        toast.fromError(error);
      },
    });
  };

  return (
    <>
      <PageHeader
        title="Record payment"
        backTo="/payments/payable"
        crumbs={[
          { label: 'Payments', to: '/payments' },
          { label: 'Payables', to: '/payments/payable' },
          { label: 'Record' },
        ]}
        meta={
          <>
            <span className="font-mono">{data.referenceNumber}</span>
            <span>{data.vendorName}</span>
            <span>Due {formatDate(data.dueDate)}</span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Payment" />
          <CardBody>
            <FormGrid columns={2}>
              <FormField
                label="Gross amount"
                required
                hint={`Outstanding on this invoice: ${formatMoney(data.outstanding)}`}
              >
                <MoneyInput value={grossAmount} onChange={setGrossAmount} />
              </FormField>

              <FormField label="Method" required>
                <Select
                  value={method}
                  options={PAYMENT_METHODS.map((value) => ({ value, label: value }))}
                  onChange={(event) => setMethod(event.target.value)}
                />
              </FormField>

              <FormField
                label="TDS amount"
                hint={
                  row?.suggestedTds
                    ? `Suggested: ${formatMoney(row.suggestedTds.amount)} under ${row.suggestedTds.section}`
                    : 'Tax deducted at source, if any.'
                }
              >
                <MoneyInput value={tdsAmount} onChange={setTdsAmount} />
              </FormField>

              <FormField label="TDS section" hint="Required when TDS is deducted.">
                <Select
                  placeholder="None"
                  value={tdsSection}
                  options={Object.entries(TDS_SECTIONS).map(([section, detail]) => ({
                    value: section,
                    label: `${section} — ${detail.label} (${detail.percent}%)`,
                  }))}
                  onChange={(event) => setTdsSection(event.target.value)}
                />
              </FormField>

              <FormField label="Retention" hint="Held back under the contract.">
                <MoneyInput value={retentionAmount} onChange={setRetentionAmount} />
              </FormField>

              <FormField label="Other deductions">
                <MoneyInput value={otherDeduction} onChange={setOtherDeduction} />
              </FormField>

              <FormField label="Paid at" required>
                <DatePicker mode="datetime" value={paidAt} onChange={setPaidAt} />
              </FormField>

              <FormField
                label="Bank reference"
                hint={
                  BANK_METHODS.includes(method as (typeof BANK_METHODS)[number])
                    ? 'UTR number, if you already have it.'
                    : 'Cheque number or transaction id.'
                }
              >
                <Input
                  value={referenceNumber}
                  className="font-mono"
                  onChange={(event) => setReferenceNumber(event.target.value)}
                />
              </FormField>

              <FormField label="Remarks" className="sm:col-span-2">
                <Textarea
                  rows={2}
                  value={remarks}
                  onChange={(event) => setRemarks(event.target.value)}
                />
              </FormField>
            </FormGrid>
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Net payable" />
            <CardBody>
              <dl className="space-y-1.5 text-sm">
                {(
                  [
                    { label: 'Gross', value: grossAmount || '0.00' },
                    { label: 'TDS', value: tdsAmount || '0.00' },
                    { label: 'Retention', value: retentionAmount || '0.00' },
                    { label: 'Other', value: otherDeduction || '0.00' },
                  ] as const
                ).map((entry) => (
                  <div key={entry.label} className="flex justify-between">
                    <dt className="text-muted">{entry.label}</dt>
                    <dd className="numeric">{formatMoney(entry.value)}</dd>
                  </div>
                ))}

                <div className="flex justify-between border-t border-border-strong pt-2 text-base font-semibold">
                  <dt>Net to vendor</dt>
                  <dd className="numeric">{formatMoney(net)}</dd>
                </div>
              </dl>

              <div className="mt-4 border-t border-border pt-3">
                <p className="text-xs text-muted">Paying to</p>
                <p className="font-mono text-xs">{row?.vendor.bankMasked ?? 'no bank details on file'}</p>
              </div>

              <Button
                className="mt-4 w-full"
                leftIcon={<Wallet className="size-3.5" />}
                disabled={problems.length > 0}
                onClick={() => setConfirming(true)}
              >
                Record payment
              </Button>

              {problems.length > 0 && (
                <p className="mt-2 text-xs text-danger">{problems[0]}</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Invoice" />
            <CardBody>
              <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
                <Field label="Reference">
                  <span className="font-mono">{data.referenceNumber}</span>
                </Field>
                <Field label="Vendor number">{data.vendorInvoiceNumber}</Field>
                <Field label="Total" numeric>
                  {formatMoney(data.totalAmount)}
                </Field>
                <Field label="Already paid" numeric>
                  {formatMoney(data.amountPaid)}
                </Field>
                <Field label="Outstanding" numeric>
                  {formatMoney(data.outstanding)}
                </Field>
              </FieldGrid>
            </CardBody>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Record this payment?"
        message={
          <>
            {formatMoney(net)} to {data.vendorName} by {method}. Above your organization's threshold
            this is held for a second administrator before it is released.
          </>
        }
        confirmLabel="Record payment"
        requireReason={false}
        destructive={false}
        loading={createPayment.isPending}
        onConfirm={submit}
      />
    </>
  );
}
