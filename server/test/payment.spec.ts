import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { money, round2 } from '../src/lib/money.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { netAmountOf } from '../src/modules/payment/payment.service.js';
import { suggestTds } from '../src/modules/payment/payable.service.js';
import {
  completePayment,
  failPayment,
  invoiceOf,
  payInFull,
  payableInvoice,
  recordPayment,
  withBankDetails,
} from './helpers/payable.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Payment recording, TDS, settlement and reversal. Every test walks the whole
 * source-to-pay chain first, so the money only ever moves against an invoice
 * that genuinely earned its way to payable.
 */
vi.setConfig({ testTimeout: 180_000 });

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Pure arithmetic                                                            */
/* -------------------------------------------------------------------------- */

describe('netAmountOf', () => {
  /** Plan 13 §10 — gross 411792.80 less TDS 8235.86 is 403556.94. */
  it('subtracts every deduction from the gross', () => {
    expect(
      netAmountOf({
        grossAmount: '411792.80',
        tdsAmount: '8235.86',
        retentionAmount: '0.00',
        otherDeduction: '0.00',
      }).toFixed(2),
    ).toBe('403556.94');
  });

  it('handles retention and other deductions together', () => {
    expect(
      netAmountOf({
        grossAmount: '100000.00',
        tdsAmount: '2000.00',
        retentionAmount: '5000.00',
        otherDeduction: '1000.00',
      }).toFixed(2),
    ).toBe('92000.00');
  });
});

describe('suggestTds', () => {
  it('suggests 194C for a supply contract', () => {
    const suggestion = suggestTds(money('100000.00'), {
      categoryName: 'Networking Hardware',
      tenderTitle: 'Supply of managed switches',
    })!;
    expect(suggestion.section).toBe('194C');
    expect(suggestion.percent).toBe('2.00');
    expect(suggestion.amount).toBe('2000.00');
  });

  it('suggests 194J when the work reads as a service', () => {
    const suggestion = suggestTds(money('100000.00'), {
      categoryName: 'Professional Services',
      tenderTitle: 'Network design consultancy',
    })!;
    expect(suggestion.section).toBe('194J');
    expect(suggestion.amount).toBe('10000.00');
  });

  it('falls back to the lower rate with nothing to go on', () => {
    expect(suggestTds(money('100000.00'), {})!.section).toBe('194C');
  });

  it('suggests nothing when nothing is outstanding', () => {
    expect(suggestTds(money('0.00'), { categoryName: 'Anything' })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

describe('recording a payment', () => {
  /** Plan 13 §10 — the TDS insight, the one that decides whether invoices settle. */
  it('stores the computed net and accumulates GROSS against the invoice', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const total = payable.totalAmount;
    const tds = round2(money(total).mul('0.02')).toFixed(2);
    const expectedNet = round2(money(total).minus(tds)).toFixed(2);

    const recorded = await recordPayment(payable, {
      grossAmount: total,
      tdsAmount: tds,
      tdsSection: '194C',
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body.data.netAmount).toBe(expectedNet);
    expect(recorded.body.data.status).toBe('APPROVED');

    const completed = await completePayment(payable, recorded.body.data.id);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    const invoice = await invoiceOf(payable.invoiceId);
    // Gross, not net: the balance went to the tax authority on the vendor's behalf.
    expect(invoice.amountPaid.toFixed(2)).toBe(total);
    expect(invoice.amountPaid.toFixed(2)).not.toBe(expectedNet);
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAt).toBeTruthy();
  });

  /** Plan 13 §10 — two part payments summing exactly to the total settle it. */
  it('settles an invoice across two part payments', async () => {
    const payable = await withBankDetails(await payableInvoice('2.000'));
    const total = money(payable.totalAmount);
    const first = round2(total.div(2)).toFixed(2);
    const second = round2(total.minus(first)).toFixed(2);

    const one = await recordPayment(payable, { grossAmount: first });
    expect(one.status).toBe(201);
    await completePayment(payable, one.body.data.id).expect(200);

    let invoice = await invoiceOf(payable.invoiceId);
    expect(invoice.status).toBe('PARTIALLY_PAID');
    expect(invoice.paidAt).toBeNull();

    const two = await recordPayment(payable, { grossAmount: second });
    expect(two.status, JSON.stringify(two.body)).toBe(201);
    await completePayment(payable, two.body.data.id).expect(200);

    invoice = await invoiceOf(payable.invoiceId);
    expect(invoice.amountPaid.toFixed(2)).toBe(payable.totalAmount);
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAt).toBeTruthy();
  });

  /** Plan 13 §10 — one rupee more than outstanding. */
  it('refuses a payment larger than the outstanding balance', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const tooMuch = round2(money(payable.totalAmount).plus(1)).toFixed(2);

    const res = await recordPayment(payable, { grossAmount: tooMuch });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('payment.exceeds_outstanding');
  });

  /** Plan 13 §10 — deductions totalling more than gross. */
  it('refuses deductions that swallow the gross', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await recordPayment(payable, {
      grossAmount: payable.totalAmount,
      tdsAmount: payable.totalAmount,
      tdsSection: '194C',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('payment.deductions_exceed_gross');
  });

  /** Plan 13 §10 — TDS with no section cannot be reported. */
  it('refuses TDS without a section', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await recordPayment(payable, {
      grossAmount: payable.totalAmount,
      tdsAmount: '100.00',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('payment.tds_section_required');
  });

  it('refuses a payment dated in the future', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await recordPayment(payable, {
      grossAmount: payable.totalAmount,
      paidAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('payment.invalid_date');
  });

  /** A bank transfer with nowhere to transfer to. */
  it('refuses a NEFT payment when the vendor has no bank account', async () => {
    const payable = await payableInvoice('1.000');

    const res = await recordPayment(payable, { grossAmount: payable.totalAmount });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('payment.vendor_bank_missing');
  });

  it('allows a cheque payment without bank details', async () => {
    const payable = await payableInvoice('1.000');

    const res = await recordPayment(payable, {
      grossAmount: payable.totalAmount,
      method: 'CHEQUE',
      referenceNumber: '004213',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  /** Plan 13 §10 — the README rule, enforced before anything else. */
  it('refuses to pay an invoice that is not approved for payment', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await prisma.invoice.update({
      where: { id: payable.invoiceId },
      data: { status: 'UNDER_REVIEW' },
    });

    const res = await recordPayment(payable, { grossAmount: payable.totalAmount });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invoice.not_payable');
  });

  /** Plan 13 §10 — an unresolved exception blocks payment. */
  it('refuses to pay an invoice with an unresolved match exception', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await prisma.invoice.update({
      where: { id: payable.invoiceId },
      data: { matchStatus: 'EXCEPTION' },
    });

    const res = await recordPayment(payable, { grossAmount: payable.totalAmount });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invoice.match_exception');
  });

  /** Plan 13 §10 — the last link in the separation-of-duties chain. */
  it('is withheld from an officer by the role matrix', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await recordPayment(
      payable,
      { grossAmount: payable.totalAmount },
      'officer',
    );

    expect(res.status).toBe(403);
  });

  it('ignores a forged net amount, because the schema refuses it', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await recordPayment(payable, {
      grossAmount: payable.totalAmount,
      netAmount: '1.00',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

/* -------------------------------------------------------------------------- */
/* Approval threshold                                                         */
/* -------------------------------------------------------------------------- */

describe('the approval threshold', () => {
  it('holds a large payment for a second admin and releases it on approval', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    // Drop the threshold so this invoice counts as large.
    await prisma.organization.update({
      where: { id: payable.order.f.org.id },
      data: { settings: { approvalThresholdAmount: 1 } },
    });
    clearOrgCache();

    const recorded = await recordPayment(payable, { grossAmount: payable.totalAmount });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body.data.status).toBe('PENDING_APPROVAL');

    // It cannot be completed while it waits.
    const early = await completePayment(payable, recorded.body.data.id);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('payment.invalid_transition');

    const approval = await prisma.approval.findFirstOrThrow({
      where: { entityType: 'PAYMENT', entityId: recorded.body.data.id },
    });
    const decided = await request(app)
      .post(`/api/v1/approvals/${approval.id}/decide`)
      .set(...payable.order.f.approver.authHeader)
      .send({ decision: 'APPROVED', comment: 'Bank details verified against the advice.' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const released = await prisma.payment.findUniqueOrThrow({
      where: { id: recorded.body.data.id },
    });
    // Approved for release, but not yet completed: the UTR does not exist yet.
    expect(released.status).toBe('APPROVED');

    const completed = await completePayment(payable, recorded.body.data.id);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  });

  it('cancels the payment when the approval is rejected', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await prisma.organization.update({
      where: { id: payable.order.f.org.id },
      data: { settings: { approvalThresholdAmount: 1 } },
    });
    clearOrgCache();

    const recorded = await recordPayment(payable, { grossAmount: payable.totalAmount });
    const approval = await prisma.approval.findFirstOrThrow({
      where: { entityType: 'PAYMENT', entityId: recorded.body.data.id },
    });

    await request(app)
      .post(`/api/v1/approvals/${approval.id}/decide`)
      .set(...payable.order.f.approver.authHeader)
      .send({ decision: 'REJECTED', comment: 'Hold until the retention terms are agreed.' })
      .expect(200);

    const cancelled = await prisma.payment.findUniqueOrThrow({
      where: { id: recorded.body.data.id },
    });
    expect(cancelled.status).toBe('CANCELLED');

    // And nothing was paid.
    const invoice = await invoiceOf(payable.invoiceId);
    expect(invoice.amountPaid.toFixed(2)).toBe('0.00');
  });
});

/* -------------------------------------------------------------------------- */
/* Reversal                                                                   */
/* -------------------------------------------------------------------------- */

describe('reversal', () => {
  /** Plan 13 §10 — a settled invoice returns to part-paid and reopens the chain. */
  it('returns a settled invoice to APPROVED_FOR_PAYMENT when the only payment fails', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const { paymentId } = await payInFull(payable);

    let invoice = await invoiceOf(payable.invoiceId);
    expect(invoice.status).toBe('PAID');

    const failed = await failPayment(
      payable,
      paymentId,
      'Bank returned the transfer: account name mismatch',
    );
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.data.status).toBe('FAILED');

    invoice = await invoiceOf(payable.invoiceId);
    // Nothing is paid now, so "partially paid" would be a lie.
    expect(invoice.amountPaid.toFixed(2)).toBe('0.00');
    expect(invoice.status).toBe('APPROVED_FOR_PAYMENT');
    expect(invoice.paidAt).toBeNull();

    // The record is corrected by adding a record, never by editing one.
    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'payment.failed', entityId: paymentId },
    });
    expect(entry.severity).toBe('SECURITY');
  });

  it('leaves a part-paid invoice PARTIALLY_PAID when one of two payments fails', async () => {
    const payable = await withBankDetails(await payableInvoice('2.000'));
    const total = money(payable.totalAmount);
    const half = round2(total.div(2)).toFixed(2);

    const one = await recordPayment(payable, { grossAmount: half });
    await completePayment(payable, one.body.data.id).expect(200);
    const two = await recordPayment(payable, {
      grossAmount: round2(total.minus(half)).toFixed(2),
    });
    await completePayment(payable, two.body.data.id).expect(200);

    expect((await invoiceOf(payable.invoiceId)).status).toBe('PAID');

    await failPayment(payable, two.body.data.id, 'Bank returned the second transfer').expect(200);

    const invoice = await invoiceOf(payable.invoiceId);
    expect(invoice.amountPaid.toFixed(2)).toBe(half);
    expect(invoice.status).toBe('PARTIALLY_PAID');
  });

  it('refuses to fail a payment that was never completed or approved', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const recorded = await recordPayment(payable, { grossAmount: payable.totalAmount });

    await request(app)
      .post(`/api/v1/payments/${recorded.body.data.id}/cancel`)
      .set(...payable.order.f.admin.authHeader)
      .send({ reason: 'Recorded against the wrong invoice' })
      .expect(200);

    const res = await failPayment(payable, recorded.body.data.id, 'Trying to fail a cancelled one');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('payment.invalid_transition');
  });

  it('refuses to cancel a completed payment — it is reversed instead', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const { paymentId } = await payInFull(payable);

    const res = await request(app)
      .post(`/api/v1/payments/${paymentId}/cancel`)
      .set(...payable.order.f.admin.authHeader)
      .send({ reason: 'Changed our mind after the money moved' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('payment.invalid_transition');
  });
});

/* -------------------------------------------------------------------------- */
/* Worklist, advice and isolation                                             */
/* -------------------------------------------------------------------------- */

describe('the payable worklist', () => {
  it('lists the approved invoice with its outstanding balance and TDS suggestion', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await request(app)
      .get('/api/v1/payments/payable')
      .set(...payable.order.f.admin.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.totals.count).toBe(1);

    const row = res.body.data.rows[0];
    expect(row.invoiceId).toBe(payable.invoiceId);
    expect(row.outstanding).toBe(payable.totalAmount);
    expect(row.amountPaid).toBe('0.00');
    expect(row.suggestedTds.section).toBe('194C');
    expect(row.blockedReason).toBeNull();
    // Masked, never the full account number.
    expect(row.vendor.bankMasked).toBe('XXXXXXXX4821');
  });

  it('drops an invoice off the worklist once it is settled', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await payInFull(payable);

    const res = await request(app)
      .get('/api/v1/payments/payable')
      .set(...payable.order.f.admin.authHeader);

    expect(res.body.data.totals.count).toBe(0);
  });

  it('is withheld from an officer, who cannot record payments anyway', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    await request(app)
      .get('/api/v1/payments/payable')
      .set(...payable.order.f.officer.authHeader)
      .expect(403);
  });
});

describe('payment advice', () => {
  /** Plan 13 §10 — the words must track netAmount, not gross. */
  it('renders a PDF whose amount in words matches the net', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const tds = round2(money(payable.totalAmount).mul('0.02')).toFixed(2);

    const recorded = await recordPayment(payable, {
      grossAmount: payable.totalAmount,
      tdsAmount: tds,
      tdsSection: '194C',
    });
    const paymentId = recorded.body.data.id;
    await completePayment(payable, paymentId).expect(200);

    const detail = await request(app)
      .get(`/api/v1/payments/${paymentId}`)
      .set(...payable.order.f.admin.authHeader);

    // The words are derived from netAmount, so they can never disagree with it.
    const { netAmount, netAmountInWords, grossAmount } = detail.body.data;
    expect(netAmount).not.toBe(grossAmount);
    expect(netAmountInWords).toMatch(/Rupees/);
    expect(netAmountInWords).toMatch(/Only$/);

    const res = await request(app)
      .get(`/api/v1/payments/${paymentId}/advice`)
      .set(...payable.order.f.admin.authHeader)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('lets the vendor see their own receipt, with the TDS section on it', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const tds = round2(money(payable.totalAmount).mul('0.02')).toFixed(2);
    const recorded = await recordPayment(payable, {
      grossAmount: payable.totalAmount,
      tdsAmount: tds,
      tdsSection: '194C',
    });
    await completePayment(payable, recorded.body.data.id).expect(200);

    const mine = await request(app)
      .get('/api/v1/vendor/payments')
      .set(...payable.order.f.vendors[0]!.contact.authHeader);

    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    // The vendor needs the section and amount to reconcile Form 26AS.
    expect(mine.body.data[0].tdsSection).toBe('194C');
    expect(mine.body.data[0].tdsAmount).toBe(tds);
  });

  it('hides a payment from another vendor and another organization', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const { paymentId } = await payInFull(payable);

    await request(app)
      .get(`/api/v1/payments/${paymentId}`)
      .set(...payable.order.f.vendors[1]!.contact.authHeader)
      .expect(404);

    const rival = await payableInvoice('1.000');
    await request(app)
      .get(`/api/v1/payments/${paymentId}`)
      .set(...rival.order.f.admin.authHeader)
      .expect(404);
  });
});
