import type { PurchaseOrderDto } from '@tb/shared';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * The purchase order as a document: both party snapshots, the tax breakdown and
 * the line items. Shared by the buyer's and the vendor's detail screens, because
 * a purchase order is one document and the two sides must read the same figures.
 *
 * The parties are the frozen snapshot taken when the order was issued, never the
 * live party rows (10 §2) — if a vendor changes their registered address next
 * month, this document still shows where the goods were actually ordered to.
 */
export function PoSummary({ po }: { po: PurchaseOrderDto }) {
  // A document prints CGST+SGST or IGST, never both (10 §3).
  const interState = po.taxRegime === 'INTER_STATE';

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title="Buyer" />
          <CardBody>
            <p className="text-sm font-medium">{po.buyer.name}</p>
            <p className="mt-1 text-xs whitespace-pre-line text-muted">{po.buyer.address}</p>
            <p className="mt-2 font-mono text-xs">{po.buyer.gstin ?? 'No GSTIN'}</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Vendor" />
          <CardBody>
            <p className="text-sm font-medium">{po.vendor.name}</p>
            <p className="mt-1 text-xs whitespace-pre-line text-muted">{po.vendor.address}</p>
            <p className="mt-2 font-mono text-xs">{po.vendor.gstin ?? 'No GSTIN'}</p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Order" />
        <CardBody>
          <FieldGrid>
            <Field label="Expected delivery">{formatDate(po.expectedDeliveryDate)}</Field>
            <Field label="Place of supply">
              {po.placeOfSupplyStateName ?? po.placeOfSupplyStateCode}
            </Field>
            <Field label="Tax regime">
              <Tooltip
                content={
                  interState
                    ? 'Supplier and place of supply are in different states, so IGST applies.'
                    : 'Supplier and place of supply are in the same state, so CGST and SGST apply.'
                }
              >
                <span>{po.taxRegime.replace('_', '-').toLowerCase()}</span>
              </Tooltip>
            </Field>
            <Field label="Payment terms">{po.paymentTerms ?? '—'}</Field>
            <Field label="Delivery address" className="col-span-2">
              {po.deliveryAddress}
            </Field>
            <Field label="Issued">{formatDate(po.issuedAt)}</Field>
            <Field label="Accepted">{formatDate(po.acceptedAt)}</Field>
          </FieldGrid>

          {po.termsAndConditions && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">
                Terms and conditions
              </p>
              <p className="text-xs whitespace-pre-wrap text-muted">{po.termsAndConditions}</p>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Line items" />
        <Table>
          <THead>
            <tr>
              <TH>#</TH>
              <TH>Description</TH>
              <TH>HSN</TH>
              <TH numeric>Quantity</TH>
              <TH numeric>Rate</TH>
              <TH numeric>Taxable</TH>
              <TH numeric>{interState ? 'IGST' : 'CGST + SGST'}</TH>
              <TH numeric>Line total</TH>
            </tr>
          </THead>
          <TBody>
            {po.items.map((item) => (
              <TR key={item.id}>
                <TD className="font-mono text-xs text-muted">{item.srNo}</TD>
                <TD>{item.description}</TD>
                <TD>
                  <span className="font-mono text-xs">{item.hsnCode ?? '—'}</span>
                </TD>
                <TD numeric>
                  {formatQty(item.quantity, item.unit)}
                  {Number(item.receivedQuantity) > 0 && (
                    <span className="block text-xs text-muted">
                      {formatQty(item.acceptedQuantity)} accepted
                    </span>
                  )}
                </TD>
                <TD numeric>{formatMoney(item.unitPrice)}</TD>
                <TD numeric>{formatMoney(item.taxableValue)}</TD>
                <TD numeric>
                  {interState
                    ? formatMoney(item.igstAmount)
                    : formatMoney(item.cgstAmount)}
                  <span className="block text-xs text-muted">{item.taxRatePercent}%</span>
                </TD>
                <TD numeric>{formatMoney(item.lineTotal)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>

        <CardBody className="border-t border-border">
          <dl className="ml-auto max-w-sm space-y-1.5 text-sm">
            {(
              [
                { label: 'Subtotal', value: po.subtotal },
                { label: 'Discount', value: po.discountAmount },
                { label: 'Taxable', value: po.taxableAmount },
                ...(interState
                  ? [{ label: 'IGST', value: po.igstAmount }]
                  : [
                      { label: 'CGST', value: po.cgstAmount },
                      { label: 'SGST', value: po.sgstAmount },
                    ]),
                { label: 'Freight', value: po.freightAmount },
                { label: 'Round off', value: po.roundOff },
              ] as const
            ).map((row) => (
              <div key={row.label} className="flex justify-between">
                <dt className="text-muted">{row.label}</dt>
                <dd className="numeric">{formatMoney(row.value)}</dd>
              </div>
            ))}

            <div className="flex justify-between border-t border-border-strong pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="numeric">{formatMoney(po.totalAmount)}</dd>
            </div>
          </dl>

          <p className="mt-3 text-right text-xs text-muted italic">{po.totalAmountInWords}</p>
        </CardBody>
      </Card>
    </div>
  );
}
