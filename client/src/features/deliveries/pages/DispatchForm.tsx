import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Truck } from 'lucide-react';
import { PERMISSIONS as P, type CreateDeliveryInput } from '@tb/shared';
import { formatQty, subtractMoney, toQtyString } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/data/EmptyState';
import { DatePicker } from '@/components/form/DatePicker';
import { FormField, FormGrid } from '@/components/form/FormField';
import { QuantityInput } from '@/components/form/QuantityInput';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { useCreateDelivery } from '@/features/deliveries/api';
import { usePurchaseOrder } from '@/features/purchaseOrders/api';

/**
 * `/vendor/purchase-orders/:id/dispatch` — the vendor's delivery note (plan 11).
 *
 * This is the vendor's assertion about what left their warehouse. It does not
 * change any accepted quantity: only the buyer's goods receipt does that, which
 * is the whole point of having both documents.
 */
export function DispatchFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();

  const po = usePurchaseOrder('vendor', id);
  const createDelivery = useCreateDelivery(id);

  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [challanNumber, setChallanNumber] = useState('');
  const [dispatchedAt, setDispatchedAt] = useState<string | null>(new Date().toISOString());
  const [expectedAt, setExpectedAt] = useState<string | null>(null);
  const [carrierName, setCarrierName] = useState('');
  const [trackingReference, setTrackingReference] = useState('');
  const [notes, setNotes] = useState('');
  const hydrated = useRef(false);

  // Prefill with everything still outstanding — the common case is dispatching
  // the whole remaining balance.
  useEffect(() => {
    if (!po.data || hydrated.current) return;
    hydrated.current = true;
    setQuantities(
      Object.fromEntries(
        po.data.items.map((item) => [
          item.id,
          subtractMoney(item.quantity, item.receivedQuantity),
        ]),
      ),
    );
  }, [po.data]);

  const problems = useMemo(() => {
    const issues: string[] = [];
    if (!po.data) return issues;

    if (challanNumber.trim().length === 0) issues.push('Give the delivery challan number.');
    if (!dispatchedAt) issues.push('Give the dispatch date.');

    let any = false;
    for (const item of po.data.items) {
      const quantity = Number(quantities[item.id] || 0);
      if (quantity <= 0) continue;
      any = true;

      const pending = Number(item.quantity) - Number(item.receivedQuantity);
      if (quantity > pending + 0.0005) {
        issues.push(
          `Line ${item.srNo}: ${formatQty(quantities[item.id])} is more than the ${formatQty(toQtyString(pending))} still outstanding.`,
        );
      }
    }
    if (!any) issues.push('Put a quantity on at least one line.');

    return issues;
  }, [po.data, quantities, challanNumber, dispatchedAt]);

  if (!can(P.DELIVERY_CREATE)) return <Forbidden />;

  if (po.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!po.data) return <EmptyState title="Purchase order not found" />;

  const data = po.data;

  if (data.status !== 'ACCEPTED') {
    return (
      <EmptyState
        title="This order cannot be dispatched against"
        message={`It is ${data.status.toLowerCase()}. Accept the order first.`}
      />
    );
  }

  const submit = () => {
    const items: CreateDeliveryInput['items'] = data.items
      .filter((item) => Number(quantities[item.id] || 0) > 0)
      .map((item) => ({
        purchaseOrderItemId: item.id,
        quantity: toQtyString(quantities[item.id] as string),
      }));

    createDelivery.mutate(
      {
        challanNumber: challanNumber.trim(),
        dispatchedAt: dispatchedAt as string,
        expectedAt: expectedAt ?? undefined,
        carrierName: carrierName.trim() || undefined,
        trackingReference: trackingReference.trim() || undefined,
        notes: notes.trim() || undefined,
        items,
      },
      {
        onSuccess: () => {
          toast.success('Delivery recorded', 'The buyer has been notified.');
          navigate(`/vendor/purchase-orders/${id}?tab=deliveries`);
        },
        onError: (error) => toast.fromError(error),
      },
    );
  };

  return (
    <>
      <PageHeader
        title={`Dispatch · ${data.poNumber}`}
        backTo={`/vendor/purchase-orders/${id}`}
        crumbs={[
          { label: 'My orders', to: '/vendor/purchase-orders' },
          { label: data.poNumber, to: `/vendor/purchase-orders/${id}` },
          { label: 'Dispatch' },
        ]}
        meta={<span>{data.buyer.name}</span>}
      />

      <Card className="mb-4">
        <CardHeader title="Challan" />
        <CardBody>
          <FormGrid columns={3}>
            <FormField label="Challan number" required>
              <Input
                value={challanNumber}
                autoFocus
                placeholder="DC-2025-0871"
                onChange={(event) => setChallanNumber(event.target.value)}
              />
            </FormField>

            <FormField label="Dispatched at" required>
              <DatePicker mode="datetime" value={dispatchedAt} onChange={setDispatchedAt} />
            </FormField>

            <FormField label="Expected arrival">
              <DatePicker mode="datetime" value={expectedAt} onChange={setExpectedAt} />
            </FormField>

            <FormField label="Carrier">
              <Input
                value={carrierName}
                placeholder="Blue Dart"
                onChange={(event) => setCarrierName(event.target.value)}
              />
            </FormField>

            <FormField label="Tracking reference">
              <Input
                value={trackingReference}
                className="font-mono"
                placeholder="BD8891234"
                onChange={(event) => setTrackingReference(event.target.value)}
              />
            </FormField>

            <FormField label="Notes" className="sm:col-span-2 lg:col-span-1">
              <Textarea
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </FormField>
          </FormGrid>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What is on this delivery" description="Prefilled with the outstanding balance." />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-subtle text-xs text-muted">
              <tr>
                <th className="px-2 py-2 text-left font-medium">#</th>
                <th className="px-2 py-2 text-left font-medium">Description</th>
                <th className="px-2 py-2 text-right font-medium">Ordered</th>
                <th className="px-2 py-2 text-right font-medium">Already received</th>
                <th className="w-36 px-2 py-2 text-right font-medium">Dispatching</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.items.map((item) => {
                const pending = subtractMoney(item.quantity, item.receivedQuantity);
                return (
                  <tr key={item.id}>
                    <td className="px-2 py-2 font-mono text-xs tabular-nums text-muted">
                      {item.srNo}
                    </td>
                    <td className="px-2 py-2">{item.description}</td>
                    <td className="numeric px-2 py-2">{formatQty(item.quantity, item.unit)}</td>
                    <td className="numeric px-2 py-2 text-muted">
                      {formatQty(item.receivedQuantity)}
                      <span className="block text-xs">{formatQty(pending)} outstanding</span>
                    </td>
                    <td className="px-2 py-2">
                      <QuantityInput
                        value={quantities[item.id] ?? ''}
                        unit={item.unit}
                        invalid={Number(quantities[item.id] || 0) > Number(pending) + 0.0005}
                        onChange={(value) =>
                          setQuantities((current) => ({ ...current, [item.id]: value }))
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <CardBody className="flex flex-wrap items-center justify-between gap-3 border-t border-border">
          {problems.length > 0 ? (
            <p className="text-xs text-danger">{problems[0]}</p>
          ) : (
            <p className="text-xs text-muted">
              The buyer records what actually arrives; this note is what you say you sent.
            </p>
          )}

          <Button
            leftIcon={<Truck className="size-3.5" />}
            disabled={problems.length > 0}
            loading={createDelivery.isPending}
            onClick={submit}
          >
            Record dispatch
          </Button>
        </CardBody>
      </Card>
    </>
  );
}
