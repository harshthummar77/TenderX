import { Document, Page, Text, View } from '@react-pdf/renderer';
import type { PoItemDto, PurchaseOrderDto } from '@tb/shared';
import { activeFontFamily, money, qty, styles } from './renderer.js';

/**
 * The purchase order document (10 §8).
 *
 * Every element below is required for the document to mean anything legally: a
 * missing GSTIN block or an unstated place of supply makes it unusable as a tax
 * document. The item table prints **either** CGST + SGST **or** IGST, never both
 * sets — `taxHeads` on the DTO decides, and it comes from the regime frozen on
 * the order when it was created.
 */

const DATE = (iso: string | null): string => (iso ? iso.slice(0, 10) : '-');

/** Column widths, as flex weights. Intra-state needs two tax columns, inter one. */
const columns = (intra: boolean) => ({
  srNo: 0.5,
  description: intra ? 3.1 : 3.6,
  hsn: 0.9,
  unit: 0.6,
  quantity: 1.1,
  rate: 1.2,
  discount: 0.7,
  taxable: 1.3,
  taxA: intra ? 1.15 : 1.4,
  taxB: intra ? 1.15 : 0,
  lineTotal: 1.4,
});

interface Props {
  po: PurchaseOrderDto;
}

const PartyBlock = ({
  heading,
  party,
}: {
  heading: string;
  party: PurchaseOrderDto['buyer'];
}) => (
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

export function PurchaseOrderPdf({ po }: Props) {
  const intra = po.taxHeads.length === 2;
  const exempt = po.taxHeads.length === 0;
  const col = columns(intra);
  const fontFamily = activeFontFamily();

  // The rate is per line, so the header names the head and each row prints its
  // own percentage — mixed rates in one document are normal (10 §3 rule 5).
  const taxAHeader = intra ? 'CGST' : 'IGST';

  const itemRow = (item: PoItemDto, index: number) => (
    <View key={item.id} style={styles.tableRow} wrap={false}>
      <Text style={[styles.cell, { flex: col.srNo }]}>{item.srNo}</Text>
      <View style={[styles.cell, { flex: col.description }]}>
        <Text>{item.description}</Text>
      </View>
      <Text style={[styles.cell, { flex: col.hsn }]}>{item.hsnCode ?? '-'}</Text>
      <Text style={[styles.cell, { flex: col.unit }]}>{item.unit}</Text>
      <Text style={[styles.cellRight, { flex: col.quantity }]}>{qty(item.quantity)}</Text>
      <Text style={[styles.cellRight, { flex: col.rate }]}>{money(item.unitPrice)}</Text>
      <Text style={[styles.cellRight, { flex: col.discount }]}>{item.discountPercent}%</Text>
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
      {index === -1 ? <Text /> : null}
    </View>
  );

  return (
    <Document
      title={`Purchase Order ${po.poNumber}`}
      author={po.buyer.name}
      subject={`Purchase order issued to ${po.vendor.name}`}
    >
      <Page size="A4" style={[styles.page, { fontFamily }]}>
        <Text style={styles.title}>PURCHASE ORDER</Text>
        <Text style={styles.subtitle}>
          {po.buyer.name}
          {po.buyer.gstin ? ` · GSTIN ${po.buyer.gstin}` : ''}
        </Text>

        <View style={styles.metaBox}>
          <View style={styles.spread}>
            <Text>
              <Text style={styles.label}>PO No: </Text>
              <Text style={styles.bold}>{po.poNumber}</Text>
            </Text>
            <Text>
              <Text style={styles.label}>Date: </Text>
              {DATE(po.issuedAt ?? po.createdAt)}
            </Text>
            <Text>
              <Text style={styles.label}>Status: </Text>
              {po.status}
            </Text>
          </View>
        </View>

        <View style={[styles.row, { marginTop: 8 }]}>
          <PartyBlock heading="BUYER / BILL TO" party={po.buyer} />
          <View style={styles.partyGap} />
          <PartyBlock heading="SUPPLIER / VENDOR" party={po.vendor} />
        </View>

        {/* Place of supply decides the tax regime, so it is stated outright. */}
        <View style={styles.metaBox}>
          <Text>
            <Text style={styles.label}>Place of supply: </Text>
            <Text style={styles.bold}>
              {po.placeOfSupplyStateName ?? '-'} ({po.placeOfSupplyStateCode})
            </Text>
            <Text style={styles.label}> · Tax: </Text>
            {po.taxRegime.replace('_', '-')}
          </Text>
          <Text>
            <Text style={styles.label}>Deliver to: </Text>
            {po.deliveryAddress}
          </Text>
          <Text>
            <Text style={styles.label}>Expected delivery: </Text>
            {DATE(po.expectedDeliveryDate)}
          </Text>
          {exempt ? (
            <Text style={styles.bold}>Supplier not registered under GST</Text>
          ) : null}
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeader} fixed>
            <Text style={[styles.cell, { flex: col.srNo }]}>Sr</Text>
            <Text style={[styles.cell, { flex: col.description }]}>Description</Text>
            <Text style={[styles.cell, { flex: col.hsn }]}>HSN/SAC</Text>
            <Text style={[styles.cell, { flex: col.unit }]}>Unit</Text>
            <Text style={[styles.cellRight, { flex: col.quantity }]}>Qty</Text>
            <Text style={[styles.cellRight, { flex: col.rate }]}>Rate</Text>
            <Text style={[styles.cellRight, { flex: col.discount }]}>Disc</Text>
            <Text style={[styles.cellRight, { flex: col.taxable }]}>Taxable</Text>
            {exempt ? null : (
              <Text style={[styles.cellRight, { flex: col.taxA }]}>{taxAHeader}</Text>
            )}
            {intra ? <Text style={[styles.cellRight, { flex: col.taxB }]}>SGST</Text> : null}
            <Text style={[styles.cellRight, { flex: col.lineTotal }]}>Line total</Text>
          </View>
          {po.items.map(itemRow)}
        </View>

        <View style={styles.totalsWrap}>
          <View style={styles.totalsBox}>
            <Row label="Taxable value" value={money(po.taxableAmount)} />
            {po.discountAmount !== '0.00' ? (
              <Row label="Discount" value={money(po.discountAmount)} />
            ) : null}
            {intra ? (
              <>
                <Row label="CGST" value={money(po.cgstAmount)} />
                <Row label="SGST" value={money(po.sgstAmount)} />
              </>
            ) : null}
            {!intra && !exempt ? <Row label="IGST" value={money(po.igstAmount)} /> : null}
            {po.freightAmount !== '0.00' ? (
              <Row label="Freight" value={money(po.freightAmount)} />
            ) : null}
            <Row label="Round off" value={money(po.roundOff)} />
            <Row label="Grand total" value={money(po.totalAmount)} bold />
          </View>
        </View>

        <View style={styles.words}>
          <Text>
            <Text style={styles.label}>Amount in words: </Text>
            <Text style={styles.bold}>{po.totalAmountInWords}</Text>
          </Text>
        </View>

        <View style={styles.terms}>
          <Text style={styles.blockHeading}>PAYMENT TERMS</Text>
          <Text>{po.paymentTerms ?? '-'}</Text>
          {po.termsAndConditions ? (
            <>
              <Text style={[styles.blockHeading, { marginTop: 6 }]}>TERMS AND CONDITIONS</Text>
              <Text>{po.termsAndConditions}</Text>
            </>
          ) : null}
        </View>

        <View style={styles.signatory}>
          <Text>For {po.buyer.name}</Text>
          <View style={{ height: 26 }} />
          <Text style={styles.signatoryLine}>Authorised Signatory</Text>
        </View>

        <View style={styles.footer} fixed>
          <Text>
            {po.poNumber} · {po.buyer.name}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}
