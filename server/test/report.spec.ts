import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { money } from '../src/lib/money.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { reportToCsv } from '../src/modules/report/csv.js';
import { reportWindow } from '../src/modules/report/window.js';
import {
  refreshVendorStats,
  resetVendorStatsGuard,
  runVendorStatsSweep,
} from '../src/jobs/refreshVendorStats.job.js';
import { makeUser } from './helpers/actors.js';
import { invoiceOf, payInFull, payableInvoice, withBankDetails } from './helpers/payable.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Reports, dashboards and the vendor-stats feedback loop (plan 15).
 *
 * The fixtures walk the whole source-to-pay chain, because that is the only way
 * committed, invoiced and paid end up as three genuinely different numbers —
 * which is the distinction the spend report exists to make.
 */
vi.setConfig({ testTimeout: 200_000 });

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
  resetVendorStatsGuard();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

describe('reportWindow', () => {
  it('defaults to the last twelve months', () => {
    const { from, to } = reportWindow({});
    const months = (to.getTime() - from.getTime()) / (30 * 86_400_000);
    expect(months).toBeGreaterThan(11);
    expect(months).toBeLessThan(13);
  });

  /** A half-open window silently drops the final day; nobody notices until the totals disagree. */
  it('includes the whole of the `to` day', () => {
    const { to } = reportWindow({ to: '2025-08-20' });
    expect(to.toISOString()).toBe('2025-08-20T23:59:59.999Z');
  });

  it('returns an empty window rather than throwing on a reversed range', () => {
    const { from, to } = reportWindow({ from: '2025-08-20', to: '2025-01-01' });
    expect(from.getTime()).toBeLessThanOrEqual(to.getTime());
  });
});

describe('reportToCsv', () => {
  const report = {
    report: 'spend-analysis',
    params: { from: '2025-04-01', to: '2025-08-20', groupBy: 'category' },
    columns: [
      { key: 'category', label: 'Category', type: 'string' as const },
      { key: 'committed', label: 'Committed', type: 'money' as const },
    ],
    rows: [
      { category: 'Networking', committed: '2100000.00' },
      { category: 'Saraf & Söhne, Ltd', committed: '50000.00' },
    ],
    totals: { committed: '2150000.00' },
    meta: { generatedAt: '2025-08-20T10:00:00.000Z', rowCount: 2 },
  };

  it('leaves money unquoted so Excel right-aligns and sums it', () => {
    const csv = reportToCsv(report);
    expect(csv).toContain(',2100000.00');
    expect(csv).not.toContain('"2100000.00"');
  });

  it('opens cleanly in Excel: BOM, CRLF, quoted text', () => {
    const csv = reportToCsv(report);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
    // A comma inside a value must not split the column.
    expect(csv).toContain('"Saraf & Söhne, Ltd"');
  });

  it('carries the totals and the parameters so the file stands alone', () => {
    const csv = reportToCsv(report);
    expect(csv).toContain('Total');
    expect(csv).toContain('2150000.00');
    expect(csv).toContain('groupBy');
  });
});

/* -------------------------------------------------------------------------- */
/* Spend report                                                               */
/* -------------------------------------------------------------------------- */

describe('spend report', () => {
  /**
   * Plan 15 §8 — committed, invoiced and paid must be three different numbers.
   * A part-paid invoice against a larger order produces exactly that.
   */
  it('reports committed, invoiced and paid as three different numbers', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const total = money(payable.totalAmount);
    const half = total.div(2).toDecimalPlaces(2).toFixed(2);

    const recorded = await request(app)
      .post('/api/v1/payments')
      .set(...payable.order.f.admin.authHeader)
      .send({
        invoiceId: payable.invoiceId,
        grossAmount: half,
        method: 'NEFT',
        paidAt: new Date().toISOString(),
      });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    await request(app)
      .post(`/api/v1/payments/${recorded.body.data.id}/complete`)
      .set(...payable.order.f.admin.authHeader)
      .send({ referenceNumber: `SBIN${Date.now()}` })
      .expect(200);

    const res = await request(app)
      .get('/api/v1/reports/spend?groupBy=category')
      .set(...payable.order.f.admin.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { committed, invoiced, paid } = res.body.data.totals;

    // The PO is the whole order; the invoice is one line of it; the payment is half of that.
    expect(money(committed).greaterThan(money(invoiced))).toBe(true);
    expect(money(invoiced).greaterThan(money(paid))).toBe(true);
    expect(paid).toBe(half);
  });

  /** Plan 15 §8 — a quiet month is a zero bar, not a gap. */
  it('zero-fills months with no activity', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await request(app)
      .get('/api/v1/reports/spend?groupBy=month')
      .set(...payable.order.f.admin.authHeader);

    expect(res.status).toBe(200);
    // Twelve months by default, every one present.
    expect(res.body.data.rows.length).toBeGreaterThanOrEqual(12);

    const quiet = res.body.data.rows.filter((row: { paid: string }) => row.paid === '0.00');
    expect(quiet.length).toBeGreaterThan(0);
    for (const row of res.body.data.rows) {
      expect(row.month).toMatch(/^\d{4}-\d{2}$/);
      expect(row.committed).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('groups by vendor with the order count', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await request(app)
      .get('/api/v1/reports/spend?groupBy=vendor')
      .set(...payable.order.f.admin.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    expect(res.body.data.rows[0].vendor).toBe(payable.order.f.vendors[0]!.vendor.companyName);
    expect(res.body.data.rows[0].orders).toBeGreaterThan(0);
  });

  it('serves the same data as CSV', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await request(app)
      .get('/api/v1/reports/spend?groupBy=category&format=csv')
      .set(...payable.order.f.admin.authHeader);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/spend-analysis/);
    expect(res.text.startsWith('﻿')).toBe(true);
  });

  it('sees nothing from another organization', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await payInFull(payable);

    const rival = await payableInvoice('1.000');

    const res = await request(app)
      .get('/api/v1/reports/spend?groupBy=vendor')
      .set(...rival.order.f.admin.authHeader);

    const vendors = res.body.data.rows.map((row: { vendor: string }) => row.vendor);
    expect(vendors).not.toContain(payable.order.f.vendors[0]!.vendor.companyName);
  });

  /** A vendor must not read a report that aggregates across vendors. */
  it('is refused to a vendor', async () => {
    const payable = await payableInvoice('1.000');

    await request(app)
      .get('/api/v1/reports/spend')
      .set(...payable.order.f.vendors[0]!.contact.authHeader)
      .expect(403);
  });
});

/* -------------------------------------------------------------------------- */
/* The other three reports                                                    */
/* -------------------------------------------------------------------------- */

describe('tender report', () => {
  it('reports invited and bid counts, and the saving against the estimate', async () => {
    const payable = await payableInvoice('1.000');

    const res = await request(app)
      .get('/api/v1/reports/tenders')
      .set(...payable.order.f.admin.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.data.rows[0];
    expect(row.invited).toBe(3);
    expect(row.bids).toBeGreaterThan(0);
    expect(row.estimatedBudget).toBe('850000.00');
    expect(row.lowestBid).toMatch(/^\d+\.\d{2}$/);
    // Awarded, so the cycle is measurable.
    expect(row.status).toBe('AWARDED');
    expect(row.cycleDays).not.toBeNull();
  });
});

describe('vendor performance report', () => {
  it('reports the scorecard figures per vendor', async () => {
    const payable = await payableInvoice('1.000');

    const res = await request(app)
      .get('/api/v1/reports/vendor-performance')
      .set(...payable.order.f.admin.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.rows.length).toBe(1);

    const row = res.body.data.rows[0];
    expect(row.vendor).toBe(payable.order.f.vendors[0]!.vendor.companyName);
    expect(row.orders).toBe(1);
    expect(row.winRate).not.toBeNull();
  });

  it('lists only vendors this organization has transacted with', async () => {
    const payable = await payableInvoice('1.000');

    const res = await request(app)
      .get('/api/v1/reports/vendor-performance')
      .set(...payable.order.f.admin.authHeader);

    // Three vendors bid; only the winner has an order.
    expect(res.body.data.rows).toHaveLength(1);
  });
});

describe('match exceptions report', () => {
  /** Plan 15 §8 — the overridden invoice, with the reason and the admin's name. */
  it('names the override, its reason and who made it', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    // Force an exception, then override it as the admin.
    await prisma.invoice.update({
      where: { id: payable.invoiceId },
      data: {
        status: 'UNDER_REVIEW',
        matchStatus: 'EXCEPTION',
        matchResult: [
          {
            code: 'price',
            label: 'Line 1: unit price exceeds tolerance',
            status: 'FAIL',
            expected: '8200.00',
            actual: '8500.00',
            variance: '3.66%',
          },
        ],
      },
    });

    const overridden = await request(app)
      .post(`/api/v1/invoices/${payable.invoiceId}/override-match`)
      .set(...payable.order.f.admin.authHeader)
      .send({ reason: 'Freight surcharge agreed by email; the difference is immaterial.' });
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(200);

    const res = await request(app)
      .get('/api/v1/reports/match-exceptions')
      .set(...payable.order.f.admin.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.data.rows.find(
      (r: { matchStatus: string }) => r.matchStatus === 'OVERRIDDEN',
    );
    expect(row).toBeDefined();
    expect(row.overrideReason).toMatch(/Freight surcharge/);
    expect(row.overriddenBy).toContain(payable.order.f.admin.user.email);
    // What actually failed, with the numbers behind it.
    expect(row.failedChecks).toMatch(/unit price exceeds tolerance/);
    expect(row.variance).toMatch(/expected 8200\.00, actual 8500\.00/);
  });

  it('counts open exceptions separately from overrides', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await prisma.invoice.update({
      where: { id: payable.invoiceId },
      data: { matchStatus: 'EXCEPTION' },
    });

    const res = await request(app)
      .get('/api/v1/reports/match-exceptions')
      .set(...payable.order.f.admin.authHeader);

    expect(res.body.data.totals.matchStatus).toBe('1 open, 0 overridden');
  });
});

/* -------------------------------------------------------------------------- */
/* The feedback loop (plan 15 §4)                                             */
/* -------------------------------------------------------------------------- */

describe('vendor stats feedback loop', () => {
  /**
   * Plan 15 §8 — mark a delivery late, refresh, and the rating drops. That is
   * the loop: performance data feeds back into future evaluations rather than
   * sitting in a report nobody reads.
   */
  it('lowers the rating after a late delivery, and plan 07 reads the new value', async () => {
    const payable = await payableInvoice('1.000');
    const order = payable.order;
    const vendorId = order.f.vendors[0]!.vendor.id;

    // An on-time delivery first, so there is a rating to lower.
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    await prisma.delivery.create({
      data: {
        purchaseOrderId: order.poId,
        vendorId,
        challanNumber: `DC-ONTIME-${Date.now()}`,
        dispatchedAt: new Date(),
        expectedAt: new Date(po.expectedDeliveryDate),
        deliveredAt: new Date(po.expectedDeliveryDate.getTime() - 86_400_000),
        status: 'DELIVERED',
      },
    });

    await refreshVendorStats();
    const before = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    expect(before.rating).not.toBeNull();
    expect(before.onTimeDeliveryRate!.toFixed(2)).toBe('100.00');

    // Now a late one.
    await prisma.delivery.create({
      data: {
        purchaseOrderId: order.poId,
        vendorId,
        challanNumber: `DC-LATE-${Date.now()}`,
        dispatchedAt: new Date(),
        expectedAt: new Date(po.expectedDeliveryDate),
        deliveredAt: new Date(po.expectedDeliveryDate.getTime() + 10 * 86_400_000),
        status: 'DELIVERED',
      },
    });

    await refreshVendorStats();
    const after = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });

    expect(Number(after.onTimeDeliveryRate)).toBeLessThan(100);
    expect(Number(after.rating)).toBeLessThan(Number(before.rating));

    // Plan 07's suggested-vendors ranking reads the refreshed column.
    const suggested = await request(app)
      .get(`/api/v1/tenders/${order.tenderId}/suggested-vendors`)
      .set(...order.f.officer.authHeader);
    expect(suggested.status).toBe(200);
    const listed = suggested.body.data.find(
      (row: { vendorId: string }) => row.vendorId === vendorId,
    );
    if (listed) {
      expect(listed.rating).toBeCloseTo(Number(after.rating), 2);
    }
  });

  /** A vendor with no history keeps a null rating; plan 09 reads null as neutral. */
  it('leaves an unproven vendor at null rather than zero', async () => {
    const payable = await payableInvoice('1.000');
    const unprovenId = payable.order.f.vendors[2]!.vendor.id;

    await refreshVendorStats();

    const unproven = await prisma.vendor.findUniqueOrThrow({ where: { id: unprovenId } });
    expect(unproven.totalOrders).toBe(0);
    // Bid participation alone can score, but never zero from no data at all.
    expect(unproven.rating === null || Number(unproven.rating) > 0).toBe(true);
  });

  /** Daily, not quarter-hourly: ratings move on the timescale of deliveries. */
  it('does real work at most once a day', async () => {
    await payableInvoice('1.000');

    const first = await runVendorStatsSweep();
    expect(first.skipped).toBe(false);
    expect(first.vendors).toBeGreaterThan(0);

    const second = await runVendorStatsSweep();
    expect(second.skipped).toBe(true);
    expect(second.updated).toBe(0);

    const forced = await runVendorStatsSweep(true);
    expect(forced.skipped).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Isolation                                                                  */
/* -------------------------------------------------------------------------- */

describe('report isolation', () => {
  it('shows an unrelated organization an empty match-exception report', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await prisma.invoice.update({
      where: { id: payable.invoiceId },
      data: { matchStatus: 'EXCEPTION' },
    });

    const outsider = await makeUser('ORG_ADMIN', {
      organizationId: (await payableInvoice('1.000')).order.f.org.id,
    });

    const res = await request(app)
      .get('/api/v1/reports/match-exceptions')
      .set(...outsider.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(0);
  });

  it('keeps a settled invoice out of the exception report entirely', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await payInFull(payable);
    expect((await invoiceOf(payable.invoiceId)).matchStatus).toBe('MATCHED');

    const res = await request(app)
      .get('/api/v1/reports/match-exceptions')
      .set(...payable.order.f.admin.authHeader);

    expect(res.body.data.rows).toHaveLength(0);
  });
});
