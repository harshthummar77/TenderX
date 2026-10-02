import { Document, Page, Text, View } from '@react-pdf/renderer';
import type { InvoiceDto, InvoiceItemDto, PurchaseOrderDto } from '@tb/shared';
import { activeFontFamily, money, qty, styles } from './renderer.js';

/**
 * The tax invoice, in the same layout family as the purchase order (plan 12 §11).
 *
 * The parties and the place of supply come off the **purchase order's frozen
 * snapshot**, not from live party rows — the invoice is a document against that
 * contract, and it must state the same regime the order was taxed under or the
 * two will not reconcile.
 *
 * As on the PO, it prints either CGST + SGST or IGST, never both sets.
 */

const DATE = (iso: string | null): string => (iso ? iso.slice(0, 10) : '-');

const columns = (intra: boolean) => ({
  srNo: 0.5,
  description: intra ? 3.2 : 3.7,
  hsn: 0.9,
  unit: 0.6,
  quantity: 1.1,
  rate: 1.2,
  taxable: 1.3,
  taxA: intra ? 1.15 : 1.4,
  taxB: intra ? 1.15 : 0,
  lineTotal: 1.4,
});

interface Props {
  invoice: InvoiceDto;
  /** The order this invoice bills against, for the frozen party blocks. */
  po: PurchaseOrderDto;
}

const PartyBlock = ({ heading, party }: { heading: string; party: PurchaseOrderDto['buyer'] }) => (
  <View style={styles.partyBlock}>
    <Text style={styles.blockHeading}>{heading}</Text>
    <Text style={styles.bold}>{party.name}</Text>
    {party.address.split('\n').map((line, index) => (
      <Text key={index}>{line}</Text>
    ))}
    <Text>
      <Text style={styles.label}>State: </Text>
      {party.stateName ?? '-'} ({party.stateCode})
    </Text>
    <Text>
      <Text style={styles.label}>GSTIN: </Text>
      {party.gstin ?? 'Not registered'}
    </Text>
  </View>
);

const Row = ({ label, value, bold }: { label: string; value: string; bold?: boolean }) => (
  <View style={bold ? styles.totalsGrand : styles.totalsRow}>
    <Text style={bold ? styles.bold : undefined}>{label}</Text>
    <Text style={bold ? styles.bold : undefined}>{value}</Text>
  </View>
);

export function InvoicePdf({ invoice, po }: Props) {
  const intra = po.taxHeads.length === 2;
  const exempt = po.taxHeads.length === 0;
  const col = columns(intra);
  const fontFamily = activeFontFamily();

  const itemRow = (item: InvoiceItemDto) => (
    <View key={item.id} style={styles.tableRow} wrap={false}>
      <Text style={[styles.cell, { flex: col.srNo }]}>{item.srNo ?? '-'}</Text>
      <View style={[styles.cell, { flex: col.description }]}>
        <Text>{item.description}</Text>
      </View>
      <Text style={[styles.cell, { flex: col.hsn }]}>{item.hsnCode ?? '-'}</Text>
      <Text style={[styles.cell, { flex: col.unit }]}>{item.unit}</Text>
      <Text style={[styles.cellRight, { flex: col.quantity }]}>{qty(item.quantity)}</Text>
      <Text style={[styles.cellRight, { flex: col.rate }]}>{money(item.unitPrice)}</Text>
      <Text style={[styles.cellRight, { flex: col.taxable }]}>{money(item.taxableValue)}</Text>
      {exempt ? null : (
        <Text style={[styles.cellRight, { flex: col.taxA }]}>
          {intra
            ? `${(Number(item.taxRatePercent) / 2).toFixed(2)}%\n${money(item.cgstAmount)}`
            : `${item.taxRatePercent}%\n${money(item.igstAmount)}`}
        </Text>
      )}
      {intra ? (
        <Text style={[styles.cellRight, { flex: col.taxB }]}>
          {`${(Number(item.taxRatePercent) / 2).toFixed(2)}%\n${money(item.sgstAmount)}`}
        </Text>
      ) : null}
      <Text style={[styles.cellRight, { flex: col.lineTotal }]}>{money(item.lineTotal)}</Text>
    </View>
  );

  return (
    <Document
      title={`Tax Invoice ${invoice.vendorInvoiceNumber}`}
      author={po.vendor.name}
      subject={`Invoice against ${po.poNumber}`}
    >
      <Page size="A4" style={[styles.page, { fontFamily }]}>
        <Text style={styles.title}>TAX INVOICE</Text>
        <Text style={styles.subtitle}>
          {po.vendor.name}
          {po.vendor.gstin ? ` · GSTIN ${po.vendor.gstin}` : ''}
        </Text>

        <View style={styles.metaBox}>
          <View style={styles.spread}>
            <Text>
              <Text style={styles.label}>Invoice No: </Text>
              <Text style={styles.bold}>{invoice.vendorInvoiceNumber}</Text>
            </Text>
            <Text>
              <Text style={styles.label}>Date: </Text>
              {DATE(invoice.invoiceDate)}
            </Text>
            <Text>
              <Text style={styles.label}>Due: </Text>
              {DATE(invoice.dueDate)}
            </Text>
          </View>
          <View style={styles.spread}>
            <Text>
              <Text style={styles.label}>Against PO: </Text>
              {po.poNumber}
            </Text>
            <Text>
              <Text style={styles.label}>Our ref: </Text>
              {invoice.referenceNumber}
            </Text>
          </View>
        </View>

        {/* Supplier first on an invoice: it is the vendor's document. */}
        <View style={[styles.row, { marginTop: 8 }]}>
          <PartyBlock heading="SUPPLIER" party={po.vendor} />
          <View style={styles.partyGap} />
          <PartyBlock heading="BILL TO" party={po.buyer} />
        </View>

        <View style={styles.metaBox}>
          <Text>
            <Text style={styles.label}>Place of supply: </Text>
            <Text style={styles.bold}>
              {po.placeOfSupplyStateName ?? '-'} ({po.placeOfSupplyStateCode})
            </Text>
            <Text style={styles.label}> · Tax: </Text>
            {po.taxRegime.replace('_', '-')}
          </Text>
          {exempt ? <Text style={styles.bold}>Supplier not registered under GST</Text> : null}
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeader} fixed>
            <Text style={[styles.cell, { flex: col.srNo }]}>Sr</Text>
            <Text style={[styles.cell, { flex: col.description }]}>Description</Text>
            <Text style={[styles.cell, { flex: col.hsn }]}>HSN/SAC</Text>
            <Text style={[styles.cell, { flex: col.unit }]}>Unit</Text>
            <Text style={[styles.cellRight, { flex: col.quantity }]}>Qty</Text>
            <Text style={[styles.cellRight, { flex: col.rate }]}>Rate</Text>
            <Text style={[styles.cellRight, { flex: col.taxable }]}>Taxable</Text>
            {exempt ? null : (
              <Text style={[styles.cellRight, { flex: col.taxA }]}>{intra ? 'CGST' : 'IGST'}</Text>
            )}
            {intra ? <Text style={[styles.cellRight, { flex: col.taxB }]}>SGST</Text> : null}
            <Text style={[styles.cellRight, { flex: col.lineTotal }]}>Line total</Text>
          </View>
          {invoice.items.map(itemRow)}
        </View>

        <View style={styles.totalsWrap}>
          <View style={styles.totalsBox}>
            <Row label="Taxable value" value={money(invoice.taxableAmount)} />
            {intra ? (
              <>
                <Row label="CGST" value={money(invoice.cgstAmount)} />
                <Row label="SGST" value={money(invoice.sgstAmount)} />
              </>
            ) : null}
            {!intra && !exempt ? <Row label="IGST" value={money(invoice.igstAmount)} /> : null}
            {invoice.freightAmount !== '0.00' ? (
              <Row label="Freight" value={money(invoice.freightAmount)} />
            ) : null}
            <Row label="Round off" value={money(invoice.roundOff)} />
            <Row label="Invoice total" value={money(invoice.totalAmount)} bold />
            {invoice.amountPaid !== '0.00' ? (
              <>
                <Row label="Paid" value={money(invoice.amountPaid)} />
                <Row label="Outstanding" value={money(invoice.outstanding)} />
              </>
            ) : null}
          </View>
        </View>

        <View style={styles.words}>
          <Text>
            <Text style={styles.label}>Amount in words: </Text>
            <Text style={styles.bold}>{invoice.totalAmountInWords}</Text>
          </Text>
        </View>

        <View style={styles.terms}>
          <Text style={styles.blockHeading}>PAYMENT TERMS</Text>
          <Text>{po.paymentTerms ?? '-'}</Text>
        </View>

        <View style={styles.signatory}>
          <Text>For {po.vendor.name}</Text>
          <View style={{ height: 26 }} />
          <Text style={styles.signatoryLine}>Authorised Signatory</Text>
        </View>

        <View style={styles.footer} fixed>
          <Text>
            {invoice.vendorInvoiceNumber} · {po.vendor.name}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
