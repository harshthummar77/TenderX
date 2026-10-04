import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, PackageCheck } from 'lucide-react';
import {
  GRN_REJECTION_REASON_MIN_LENGTH,
  PERMISSIONS as P,
  type CreateGrnInput,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import { addQty, formatDate, formatQty, subtractMoney, toQtyString } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/data/EmptyState';
import { DatePicker } from '@/components/form/DatePicker';
import { FormField } from '@/components/form/FormField';
import { QuantityInput } from '@/components/form/QuantityInput';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { useCreateGrn, useReceivable } from '@/features/grns/api';

/**
 * `/purchase-orders/:id/receive` — goods receipt capture (plan 17 §6).
 *
 * The rule the screen exists to enforce: **accepted + rejected must equal
 * received, on every line.** The submit button stays disabled until every row
 * balances, so the officer fixes the arithmetic while the delivery is in front of
 * them rather than reading a 422 afterwards.
 *
 * Rejecting anything reveals a required reason — the rejection is what the vendor
 * is told, and what the three-way match later holds the invoice against.
 */

interface RowDraft {
  received: string;
  accepted: string;
  rejected: string;
  reason: string;
}

export function GrnCapturePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();

  const receivable = useReceivable(id);
  const createGrn = useCreateGrn(id);

  const [rows, setRows] = useState<Record<string, RowDraft>>({});
  const [deliveryId, setDeliveryId] = useState('');
  const [receivedAt, setReceivedAt] = useState<string | null>(new Date().toISOString());
  const [remarks, setRemarks] = useState('');
  const hydrated = useRef(false);

  useEffect(() => {
    if (!receivable.data || hydrated.current) return;
    hydrated.current = true;

    setRows(
      Object.fromEntries(
        receivable.data.lines.map((line) => [
          line.purchaseOrderItemId,
          {
            // Prefilled from the open deliveries, capped at what is still pending.
            received: Number(line.suggestedReceive) > 0 ? line.suggestedReceive : '',
            accepted: Number(line.suggestedReceive) > 0 ? line.suggestedReceive : '',
            rejected: '',
            reason: '',
          },
        ]),
      ),
    );

    const firstDelivery = receivable.data.openDeliveries[0];
    if (firstDelivery) setDeliveryId(firstDelivery.id);
  }, [receivable.data]);

  const lines = receivable.data?.lines ?? [];

  const problems = useMemo(() => {
    const issues: string[] = [];
    let anyReceived = false;

    for (const line of lines) {
      const row = rows[line.purchaseOrderItemId];
      if (!row) continue;

      const received = Number(row.received || 0);
      const accepted = Number(row.accepted || 0);
      const rejected = Number(row.rejected || 0);

      if (received === 0) continue;
      anyReceived = true;

      // The one hard rule on this screen.
      if (Math.abs(accepted + rejected - received) > 0.0005) {
        issues.push(
          `Line ${line.srNo}: accepted + rejected (${formatQty(toQtyString(accepted + rejected))}) must equal received (${formatQty(row.received)}).`,
        );
      }
      if (received > Number(line.pending) + 0.0005) {
        issues.push(
          `Line ${line.srNo}: receiving ${formatQty(row.received)} is more than the ${formatQty(line.pending)} still pending.`,
        );
      }
      if (rejected > 0 && row.reason.trim().length < GRN_REJECTION_REASON_MIN_LENGTH) {
        issues.push(
          `Line ${line.srNo}: a rejection needs a reason of at least ${GRN_REJECTION_REASON_MIN_LENGTH} characters.`,
        );
      }
    }

    if (!anyReceived) issues.push('Enter a received quantity on at least one line.');
    if (!receivedAt) issues.push('Give the date the goods arrived.');

    return issues;
  }, [lines, rows, receivedAt]);

  if (!can(P.GRN_CREATE)) return <Forbidden />;

  if (receivable.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!receivable.data) {
    return <EmptyState title="Nothing to receive" message="This order cannot be received against." />;
  }

  const { purchaseOrder, openDeliveries } = receivable.data;
  const selectedDelivery = openDeliveries.find((delivery) => delivery.id === deliveryId);

  const setRow = (itemId: string, changes: Partial<RowDraft>) =>
    setRows((current) => ({
      ...current,
      [itemId]: {
        received: '',
        accepted: '',
        rejected: '',
        reason: '',
        ...(current[itemId] ?? {}),
        ...changes,
      },
    }));

  /** Typing a received quantity fills accepted with the same figure. */
  const onReceivedChange = (itemId: string, value: string) => {
    const row = rows[itemId];
    const rejected = row?.rejected ?? '';
    setRow(itemId, {
      received: value,
      accepted: Number(rejected) > 0 ? subtractMoney(value || '0', rejected) : value,
    });
  };

  /** Typing a rejected quantity leaves the rest accepted, which is the common case. */
  const onRejectedChange = (itemId: string, value: string) => {
    const row = rows[itemId];
    const received = row?.received ?? '';
    setRow(itemId, {
      rejected: value,
      accepted: received ? subtractMoney(received, value || '0') : '',
    });
  };

  const submit = () => {
    const items: CreateGrnInput['items'] = lines
      .filter((line) => Number(rows[line.purchaseOrderItemId]?.received || 0) > 0)
      .map((line) => {
        const row = rows[line.purchaseOrderItemId] as RowDraft;
        return {
          purchaseOrderItemId: line.purchaseOrderItemId,
          receivedQuantity: toQtyString(row.received),
          acceptedQuantity: toQtyString(row.accepted || '0'),
          rejectedQuantity: toQtyString(row.rejected || '0'),
          rejectionReason: Number(row.rejected || 0) > 0 ? row.reason.trim() : undefined,
        };
      });

    createGrn.mutate(
      {
        deliveryId: deliveryId || undefined,
        receivedAt: receivedAt as string,
        remarks: remarks.trim() || undefined,
        items,
      },
      {
        onSuccess: (grn) => {
          toast.success(
            `Goods receipt ${grn.grnNumber} recorded`,
            `Status: ${grn.status.toLowerCase().replace(/_/g, ' ')}`,
          );
          navigate(`/grns/${grn.id}`);
        },
        onError: (error) => toast.fromError(error),
      },
    );
  };

  return (
    <>
      <PageHeader
        title={`Receive goods · ${purchaseOrder.poNumber}`}
        backTo={`/purchase-orders/${id}`}
        crumbs={[
          { label: 'Orders', to: '/purchase-orders' },
          { label: purchaseOrder.poNumber, to: `/purchase-orders/${id}` },
          { label: 'Receive' },
        ]}
        meta={
          <>
            <span>{purchaseOrder.vendorName}</span>
            <span>{purchaseOrder.fulfilmentStatus.toLowerCase().replace(/_/g, ' ')}</span>
          </>
        }
      />

      <Card className="mb-4">
        <CardHeader title="This receipt" />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <FormField
            label="Against delivery"
            hint={
              openDeliveries.length === 0
                ? 'No open delivery — you can still receive without one.'
                : 'Links the receipt to the vendor’s challan.'
            }
          >
            <Select
              placeholder="No delivery note"
              value={deliveryId}
              options={openDeliveries.map((delivery) => ({
                value: delivery.id,
                label: `${delivery.challanNumber} · dispatched ${formatDate(delivery.dispatchedAt)}`,
              }))}
              onChange={(event) => setDeliveryId(event.target.value)}
            />
          </FormField>

          <FormField label="Received at" required>
            <DatePicker mode="datetime" value={receivedAt} onChange={setReceivedAt} />
          </FormField>

          <FormField label="Remarks">
            <Input
              value={remarks}
              placeholder="Condition on arrival, who checked it…"
              onChange={(event) => setRemarks(event.target.value)}
            />
          </FormField>
        </CardBody>
      </Card>

      {selectedDelivery && (
        <p className="mb-3 text-xs text-muted">
          Delivery {selectedDelivery.challanNumber} · dispatched{' '}
          {formatDate(selectedDelivery.dispatchedAt)}
          {selectedDelivery.expectedAt && ` · expected ${formatDate(selectedDelivery.expectedAt)}`}
        </p>
      )}

      <Card>
        <CardHeader
          title="Lines"
          description="Received is what arrived. Accepted plus rejected has to equal it."
        />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-subtle text-xs text-muted">
              <tr>
                <th className="px-2 py-2 text-left font-medium">#</th>
                <th className="px-2 py-2 text-left font-medium">Description</th>
                <th className="px-2 py-2 text-right font-medium">Ordered</th>
                <th className="px-2 py-2 text-right font-medium">Already</th>
                <th className="w-32 px-2 py-2 text-right font-medium">This delivery</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Accept</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Reject</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((line) => {
                const row = rows[line.purchaseOrderItemId];
                const received = Number(row?.received || 0);
                const accepted = Number(row?.accepted || 0);
                const rejected = Number(row?.rejected || 0);
                const balanced = Math.abs(accepted + rejected - received) < 0.0005;
                const rejecting = rejected > 0;

                return (
                  <tr key={line.purchaseOrderItemId} className="align-top">
                    <td className="px-2 py-2 font-mono text-xs tabular-nums text-muted">
                      {line.srNo}
                    </td>
                    <td className="px-2 py-2">
                      <p>{line.description}</p>
                      {rejecting && (
                        <div className="mt-1.5">
                          <Input
                            value={row?.reason ?? ''}
                            invalid={
                              (row?.reason ?? '').trim().length < GRN_REJECTION_REASON_MIN_LENGTH
                            }
                            placeholder="Why was part of this line rejected?"
                            className="h-8 text-xs"
                            onChange={(event) =>
                              setRow(line.purchaseOrderItemId, { reason: event.target.value })
                            }
                          />
                        </div>
                      )}
                    </td>
                    <td className="numeric px-2 py-2">{formatQty(line.ordered, line.unit)}</td>
                    <td className="numeric px-2 py-2 text-muted">
                      {formatQty(line.alreadyReceived)}
                      <span className="block text-xs">{formatQty(line.pending)} pending</span>
                    </td>
                    <td className="px-2 py-2">
                      <QuantityInput
                        value={row?.received ?? ''}
                        unit={line.unit}
                        invalid={received > Number(line.pending) + 0.0005}
                        onChange={(value) => onReceivedChange(line.purchaseOrderItemId, value)}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <QuantityInput
                        value={row?.accepted ?? ''}
                        invalid={!balanced}
                        onChange={(value) =>
                          setRow(line.purchaseOrderItemId, { accepted: value })
                        }
                      />
                    </td>
                    <td className="px-2 py-2">
                      <QuantityInput
                        value={row?.rejected ?? ''}
                        invalid={!balanced}
                        onChange={(value) => onRejectedChange(line.purchaseOrderItemId, value)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <CardBody className="border-t border-border">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {problems.length > 0 ? (
                <div className="flex items-start gap-2 text-xs text-danger">
                  <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <ul className="space-y-0.5">
                    {problems.slice(0, 3).map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                    {problems.length > 3 && <li>and {problems.length - 3} more.</li>}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-success">
                  Every line balances. Total received{' '}
                  {formatQty(
                    lines.reduce(
                      (sum, line) => addQty(sum, rows[line.purchaseOrderItemId]?.received || '0'),
                      '0.000',
                    ),
                  )}
                  .
                </p>
              )}
            </div>

            <Button
              leftIcon={<PackageCheck className="size-3.5" />}
              disabled={problems.length > 0}
              loading={createGrn.isPending}
              onClick={submit}
              className={cn(problems.length > 0 && 'cursor-not-allowed')}
            >
              Record GRN
            </Button>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
