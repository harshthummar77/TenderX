import { Document, Page, Text, View } from '@react-pdf/renderer';
import type { PaymentDto, PurchaseOrderDto } from '@tb/shared';
import { TDS_SECTIONS } from '@tb/shared';
import { activeFontFamily, money, styles } from './renderer.js';

/**
 * The payment advice (plan 13 §7) — one page, emailed to the vendor.
 *
 * **The TDS lines are what make it a real document.** A vendor needs the section
 * and the amount to reconcile their Form 26AS; an advice that showed only the net
 * figure would leave them unable to account for the difference between what they
 * invoiced and what arrived in their bank.
 */

const DATE = (iso: string | null): string => (iso ? iso.slice(0, 10) : '-');

interface Props {
  payment: PaymentDto;
  po: PurchaseOrderDto;
  invoice: {
    referenceNumber: string;
    vendorInvoiceNumber: string;
    invoiceDate: string;
    totalAmount: string;
    amountPaid: string;
  };
}

const PartyBlock = ({ heading, party }: { heading: string; party: PurchaseOrderDto['buyer'] }) => (
  <View style={styles.partyBlock}>
    <Text style={styles.blockHeading}>{heading}</Text>
    <Text style={styles.bold}>{party.name}</Text>
    {party.address.split('\n').map((line, index) => (
      <Text key={index}>{line}</Text>
    ))}
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

export function PaymentAdvicePdf({ payment, po, invoice }: Props) {
  const fontFamily = activeFontFamily();
  const section = payment.tdsSection as keyof typeof TDS_SECTIONS | null;
  const sectionLabel = section ? TDS_SECTIONS[section]?.label : null;

  const hasDeductions =
    payment.tdsAmount !== '0.00' ||
    payment.retentionAmount !== '0.00' ||
    payment.otherDeduction !== '0.00';

  const balance = payment.invoiceOutstanding;

  return (
    <Document
      title={`Payment Advice ${payment.paymentNumber}`}
      author={po.buyer.name}
      subject={`Payment against ${invoice.vendorInvoiceNumber}`}
    >
      <Page size="A4" style={[styles.page, { fontFamily }]}>
        <Text style={styles.title}>PAYMENT ADVICE</Text>
        <Text style={styles.subtitle}>{po.buyer.name}</Text>

        <View style={styles.metaBox}>
          <View style={styles.spread}>
            <Text>
              <Text style={styles.label}>Advice No: </Text>
              <Text style={styles.bold}>{payment.paymentNumber}</Text>
            </Text>
            <Text>
              <Text style={styles.label}>Date: </Text>
              {DATE(payment.paidAt)}
            </Text>
            <Text>
              <Text style={styles.label}>Status: </Text>
              {payment.status}
            </Text>
          </View>
          <View style={styles.spread}>
            <Text>
              <Text style={styles.label}>Method: </Text>
              {payment.method}
            </Text>
            <Text>
              <Text style={styles.label}>Bank reference: </Text>
              {payment.referenceNumber ?? 'pending'}
            </Text>
            {payment.valueDate ? (
              <Text>
                <Text style={styles.label}>Value date: </Text>
                {DATE(payment.valueDate)}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={[styles.row, { marginTop: 8 }]}>
          <PartyBlock heading="PAYER" party={po.buyer} />
          <View style={styles.partyGap} />
          <PartyBlock heading="PAYEE" party={po.vendor} />
        </View>

        {/* What this payment settles. */}
        <View style={styles.metaBox}>
          <Text style={styles.blockHeading}>AGAINST INVOICE</Text>
          <View style={styles.spread}>
            <Text>
              <Text style={styles.label}>Invoice: </Text>
              <Text style={styles.bold}>{invoice.vendorInvoiceNumber}</Text>
            </Text>
            <Text>
              <Text style={styles.label}>Dated: </Text>
              {DATE(invoice.invoiceDate)}
            </Text>
            <Text>
              <Text style={styles.label}>Our ref: </Text>
              {invoice.referenceNumber}
            </Text>
          </View>
          <View style={styles.spread}>
            <Text>
              <Text style={styles.label}>Invoice total: </Text>
              {money(invoice.totalAmount)}
            </Text>
            <Text>
              <Text style={styles.label}>Against PO: </Text>
              {po.poNumber}
            </Text>
          </View>
        </View>

        <View style={styles.totalsWrap}>
          <View style={styles.totalsBox}>
            <Row label="Gross amount" value={money(payment.grossAmount)} />
            {payment.tdsAmount !== '0.00' ? (
              <Row
                label={`Less TDS${section ? ` u/s ${section}` : ''}`}
                value={money(payment.tdsAmount)}
              />
            ) : null}
            {payment.retentionAmount !== '0.00' ? (
              <Row label="Less retention" value={money(payment.retentionAmount)} />
            ) : null}
            {payment.otherDeduction !== '0.00' ? (
              <Row label="Less other deductions" value={money(payment.otherDeduction)} />
            ) : null}
            <Row label="Net amount paid" value={money(payment.netAmount)} bold />
          </View>
        </View>

        {hasDeductions && section ? (
          <View style={styles.metaBox}>
            <Text style={styles.blockHeading}>TAX DEDUCTED AT SOURCE</Text>
            <Text>
              <Text style={styles.label}>Section: </Text>
              {section}
              {sectionLabel ? ` — ${sectionLabel}` : ''}
            </Text>
            <Text>
              <Text style={styles.label}>Rate applied: </Text>
              {TDS_SECTIONS[section]?.percent ?? '-'}%
              <Text style={styles.label}> · Amount: </Text>
              {money(payment.tdsAmount)}
            </Text>
            <Text style={styles.label}>
              This amount has been remitted to the Income Tax Department on your behalf and will
              appear in your Form 26AS.
            </Text>
          </View>
        ) : null}

        <View style={styles.words}>
          <Text>
            <Text style={styles.label}>Net amount in words: </Text>
            <Text style={styles.bold}>{payment.netAmountInWords}</Text>
          </Text>
        </View>

        {balance && balance !== '0.00' ? (
          <View style={styles.terms}>
            <Text>
              <Text style={styles.label}>Balance outstanding on this invoice: </Text>
              <Text style={styles.bold}>{money(balance)}</Text>
            </Text>
          </View>
        ) : (
          <View style={styles.terms}>
            <Text style={styles.bold}>This invoice is now fully settled.</Text>
          </View>
        )}

        {payment.remarks ? (
          <View style={styles.terms}>
            <Text style={styles.blockHeading}>REMARKS</Text>
            <Text>{payment.remarks}</Text>
          </View>
        ) : null}

        <View style={styles.signatory}>
          <Text>For {po.buyer.name}</Text>
          <View style={{ height: 26 }} />
          <Text style={styles.signatoryLine}>Authorised Signatory</Text>
        </View>

        <View style={styles.footer} fixed>
          <Text>
            {payment.paymentNumber} · {po.buyer.name}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
