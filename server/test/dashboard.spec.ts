import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { money } from '../src/lib/money.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { makeUser } from './helpers/actors.js';
import { bidFixture, placeBid, publishTender } from './helpers/bidding.js';
import { payableInvoice, withBankDetails } from './helpers/payable.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Role dashboards (plan 15 §2).
 *
 * The properties under test are the ones that make a dashboard useful rather
 * than decorative: every tile carries a link, the tiles an actor cannot act on
 * are absent, and a vendor sees only their own numbers.
 */
vi.setConfig({ testTimeout: 200_000 });

const dashboardFor = (auth: [string, string]) =>
  request(app)
    .get('/api/v1/dashboard')
    .set(...auth);

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Buyer                                                                      */
/* -------------------------------------------------------------------------- */

describe('buyer dashboard', () => {
  it('returns one payload with tiles, KPIs and the spend trend', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await dashboardFor(payable.order.f.admin.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.role).toBe('ORG_ADMIN');

    // Everything the page needs, in one round trip.
    expect(res.body.data).toHaveProperty('actionRequired');
    expect(res.body.data).toHaveProperty('kpis');
    expect(res.body.data).toHaveProperty('spendTrend');
    expect(res.body.data).toHaveProperty('topVendors');
    expect(res.body.data).toHaveProperty('byCategory');
    expect(res.body.data).toHaveProperty('closingSoon');
    expect(res.body.data).toHaveProperty('recentActivity');

    // Six months of trend, zero-filled rather than gapped.
    expect(res.body.data.spendTrend).toHaveLength(6);
    for (const point of res.body.data.spendTrend) {
      expect(point.month).toMatch(/^\d{4}-\d{2}$/);
      expect(point.paid).toMatch(/^\d+\.\d{2}$/);
    }
  });

  /** Plan 15 §1 — a tile you cannot click is decoration. */
  it('gives every tile a link', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const order = payable.order;

    /*
     * The payable fixture leaves nothing outstanding, so it produces no tiles at
     * all. Put real work back on the org first, or this asserts a property of an
     * empty array.
     */
    await prisma.invoice.update({
      where: { id: payable.invoiceId },
      data: { status: 'UNDER_REVIEW', matchStatus: 'EXCEPTION' },
    });
    await prisma.approval.create({
      data: {
        organizationId: order.f.org.id,
        entityType: 'TENDER_AWARD',
        entityId: order.tenderId,
        amount: '100000.00',
        requestedById: order.f.officer.user.id,
        requestNote: 'Pending for the dashboard test',
        status: 'PENDING',
      },
    });

    const res = await dashboardFor(order.f.admin.authHeader);

    expect(res.body.data.actionRequired.length).toBeGreaterThan(0);
    for (const tile of res.body.data.actionRequired) {
      expect(tile.link, tile.key).toBeTruthy();
      expect(tile.link.startsWith('/'), tile.key).toBe(true);
      expect(typeof tile.count).toBe('number');
      // A tile is an action, so it only exists when there is something to do.
      expect(tile.count, tile.key).toBeGreaterThan(0);
    }
  });

  /**
   * An organization with nothing outstanding gets an empty list, not invented
   * tiles. "Action first" also means no action, no tile.
   */
  it('returns no tiles when there is nothing to act on', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await dashboardFor(payable.order.f.admin.authHeader);

    expect(res.body.data.actionRequired).toEqual([]);
    // The rest of the payload is still there; only the tiles are empty.
    expect(res.body.data.spendTrend).toHaveLength(6);
  });

  /**
   * Plan 15 §8 — an officer's dashboard has no approval or payment tiles; an
   * admin's does. The difference is driven by permission, not role name:
   * showing somebody a count they cannot act on is noise.
   */
  it('omits the tiles an officer has no permission to act on', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    const order = payable.order;

    // Raise an approval so the admin genuinely has one waiting.
    await prisma.approval.create({
      data: {
        organizationId: order.f.org.id,
        entityType: 'TENDER_AWARD',
        entityId: order.tenderId,
        amount: '100000.00',
        requestedById: order.f.officer.user.id,
        requestNote: 'Pending for the dashboard test',
        status: 'PENDING',
      },
    });

    const admin = await dashboardFor(order.f.admin.authHeader);
    const officer = await dashboardFor(order.f.officer.authHeader);

    const keysOf = (res: { body: { data: { actionRequired: { key: string }[] } } }) =>
      res.body.data.actionRequired.map((tile) => tile.key);

    expect(admin.body.data.role).toBe('ORG_ADMIN');
    expect(officer.body.data.role).toBe('ORG_OFFICER');

    expect(keysOf(admin)).toContain('approvals_pending');
    expect(keysOf(officer)).not.toContain('approvals_pending');
    expect(keysOf(officer)).not.toContain('payments_due');
    expect(keysOf(officer)).not.toContain('vendors_pending');
  });

  it('counts a match exception as a high-severity tile', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await prisma.invoice.update({
      where: { id: payable.invoiceId },
      data: { matchStatus: 'EXCEPTION' },
    });

    const res = await dashboardFor(payable.order.f.admin.authHeader);
    const tile = res.body.data.actionRequired.find(
      (t: { key: string }) => t.key === 'match_exceptions',
    );

    expect(tile).toBeDefined();
    expect(tile.count).toBe(1);
    expect(tile.severity).toBe('high');
    expect(tile.link).toContain('matchStatus=EXCEPTION');
  });

  /** Plan 15 §8 — each tile's count must match the list its link points at. */
  it('matches the invoices-to-verify tile against the filtered list', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));
    await prisma.invoice.update({
      where: { id: payable.invoiceId },
      data: { status: 'UNDER_REVIEW' },
    });

    const res = await dashboardFor(payable.order.f.admin.authHeader);
    const tile = res.body.data.actionRequired.find(
      (t: { key: string }) => t.key === 'invoices_to_verify',
    );
    expect(tile.count).toBe(1);

    const list = await request(app)
      .get('/api/v1/invoices?status=UNDER_REVIEW')
      .set(...payable.order.f.admin.authHeader);
    expect(list.body.data).toHaveLength(tile.count);
  });

  it('lists a tender closing inside 24 hours', async () => {
    const f = await bidFixture(3);
    const tender = await publishTender(f, {
      bidSubmissionDeadline: new Date(Date.now() + 6 * 3_600_000).toISOString(),
      deliveryDeadline: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    await placeBid(f, tender.id, 0, { prices: ['58500.00', '8200.00'] });

    const res = await dashboardFor(f.officer.authHeader);

    expect(res.body.data.closingSoon).toHaveLength(1);
    expect(res.body.data.closingSoon[0].tenderId).toBe(tender.id);
    expect(res.body.data.closingSoon[0].bidCount).toBe(1);
  });

  it('shows no SECURITY rows in recent activity', async () => {
    const payable = await withBankDetails(await payableInvoice('1.000'));

    const res = await dashboardFor(payable.order.f.admin.authHeader);

    for (const row of res.body.data.recentActivity) {
      expect(row.severity).not.toBe('SECURITY');
    }
  });

  it('keeps one organization figures out of another', async () => {
    const mine = await withBankDetails(await payableInvoice('1.000'));
    const theirs = await payableInvoice('1.000');

    const res = await dashboardFor(theirs.order.f.admin.authHeader);

    const vendorNames = res.body.data.topVendors.map((row: { name: string }) => row.name);
    // Both fixtures use the same vendor company names, so compare the ids.
    const vendorIds = res.body.data.topVendors.map((row: { vendorId: string }) => row.vendorId);
    expect(vendorIds).not.toContain(mine.order.f.vendors[0]!.vendor.id);
    expect(vendorNames.length).toBeLessThanOrEqual(5);
  });
});

/* -------------------------------------------------------------------------- */
/* Vendor                                                                     */
/* -------------------------------------------------------------------------- */

describe('vendor dashboard', () => {
  it('returns the vendor payload with ageing and bid history', async () => {
    const payable = await payableInvoice('1.000');

    const res = await dashboardFor(payable.order.f.vendors[0]!.contact.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.role).toBe('VENDOR');
    expect(res.body.data).toHaveProperty('receivableAgeing');
    expect(res.body.data).toHaveProperty('bidHistory');

    // Six months, zero-filled.
    expect(res.body.data.bidHistory).toHaveLength(6);
    for (const point of res.body.data.bidHistory) {
      expect(point.month).toMatch(/^\d{4}-\d{2}$/);
      expect(typeof point.submitted).toBe('number');
    }

    // Five ageing buckets, every one present even at zero.
    expect(res.body.data.receivableAgeing.map((b: { bucket: string }) => b.bucket)).toEqual([
      'Not due',
      '0-30',
      '31-60',
      '61-90',
      '90+',
    ]);
  });

  it('counts the approved invoice as an outstanding receivable', async () => {
    const payable = await payableInvoice('1.000');

    const res = await dashboardFor(payable.order.f.vendors[0]!.contact.authHeader);

    expect(res.body.data.kpis.outstandingReceivable).toBe(payable.totalAmount);
    const notDue = res.body.data.receivableAgeing.find(
      (b: { bucket: string }) => b.bucket === 'Not due',
    );
    expect(notDue.amount).toBe(payable.totalAmount);
  });

  it('offers a ready-to-invoice tile only while something is uninvoiced', async () => {
    const f = await bidFixture(3);
    const tender = await publishTender(f);
    await placeBid(f, tender.id, 0, { prices: ['58500.00', '8200.00'] });

    // A bid, but no order yet: nothing to invoice.
    const early = await dashboardFor(f.vendors[0]!.contact.authHeader);
    const keys = early.body.data.actionRequired.map((t: { key: string }) => t.key);
    expect(keys).not.toContain('ready_to_invoice');
    expect(keys).toContain('invitations_open');
  });

  it('flags a rejected invoice as needing correction', async () => {
    const payable = await payableInvoice('1.000');
    await prisma.invoice.update({
      where: { id: payable.invoiceId },
      data: { status: 'REJECTED', rejectionReason: 'Wrong HSN on line 1' },
    });

    const res = await dashboardFor(payable.order.f.vendors[0]!.contact.authHeader);
    const tile = res.body.data.actionRequired.find(
      (t: { key: string }) => t.key === 'invoices_rejected',
    );

    expect(tile).toBeDefined();
    expect(tile.severity).toBe('high');
  });

  /** Plan 15 §8 — a vendor sees only their own numbers. */
  it('shows a vendor nothing belonging to another vendor', async () => {
    const payable = await payableInvoice('1.000');

    const winner = await dashboardFor(payable.order.f.vendors[0]!.contact.authHeader);
    const loser = await dashboardFor(payable.order.f.vendors[1]!.contact.authHeader);

    expect(money(winner.body.data.kpis.outstandingReceivable).greaterThan(0)).toBe(true);
    // The losing bidder has no order and no receivable.
    expect(loser.body.data.kpis.outstandingReceivable).toBe('0.00');
    expect(loser.body.data.kpis.activeOrders).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Platform                                                                   */
/* -------------------------------------------------------------------------- */

describe('platform dashboard', () => {
  it('returns stats plus system health', async () => {
    await payableInvoice('1.000');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await dashboardFor(platformAdmin.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.role).toBe('PLATFORM_ADMIN');
    expect(res.body.data).toHaveProperty('stats');

    const { health } = res.body.data;
    expect(health.auditChainValid).toBe(true);
    expect(health.auditRows).toBeGreaterThan(0);
    expect(typeof health.dbResponseMs).toBe('number');
    expect(typeof health.unsentNotifications).toBe('number');
    expect(typeof health.failedEmails24h).toBe('number');
  });

  it('raises a high-severity tile when a vendor is awaiting approval', async () => {
    await prisma.vendor.create({
      data: {
        companyName: 'Awaiting Review Supplies',
        email: `pending-${Date.now()}@example.test`,
        phone: '9876500000',
        addressLine1: '9 Industrial Estate',
        city: 'Surat',
        state: 'Gujarat',
        stateCode: '24',
        pincode: '395001',
        status: 'PENDING_APPROVAL',
      },
    });
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await dashboardFor(platformAdmin.authHeader);
    const tile = res.body.data.actionRequired.find(
      (t: { key: string }) => t.key === 'vendors_pending',
    );

    expect(tile).toBeDefined();
    expect(tile.count).toBe(1);
  });
});

describe('access', () => {
  it('requires authentication', async () => {
    await request(app).get('/api/v1/dashboard').expect(401);
  });
});
