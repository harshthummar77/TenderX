import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_TYPES } from '@tb/shared';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { notify, notifyMany } from '../src/lib/notify.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import {
  attemptsOf,
  EMAIL_EVENTS,
  MAX_EMAIL_ATTEMPTS,
  notificationPreferences,
  retryFailedEmails,
} from '../src/modules/notification/notification.service.js';
import { renderEmail } from '../src/modules/notification/templates.js';
import { makeOrganization, makeUser } from './helpers/actors.js';
import { bidFixture, placeBid, publishTender } from './helpers/bidding.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Notifications (plan 14 Part B).
 *
 * The two properties under test are the ones the design rests on: the in-app row
 * is transactional, and the amount-suppression rule holds during the sealed
 * phase.
 */
vi.setConfig({ testTimeout: 120_000 });

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Transactionality                                                           */
/* -------------------------------------------------------------------------- */

describe('transactional delivery', () => {
  /**
   * Plan 14 acceptance — rolling back leaves no notification rows. Nobody is
   * ever told "you were invited to a tender that does not exist".
   */
  it('writes no row when the surrounding transaction rolls back', async () => {
    const org = await makeOrganization('Rollback Ltd');
    const user = await makeUser('ORG_ADMIN', { organizationId: org.id });

    await expect(
      prisma.$transaction(async (tx) => {
        await notify(tx, {
          userId: user.user.id,
          type: 'TENDER_INVITED',
          title: 'You were invited',
          body: 'To a tender that is about to not exist',
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(await prisma.notification.count({ where: { userId: user.user.id } })).toBe(0);
  });

  it('writes one row per recipient and hands back their ids', async () => {
    const org = await makeOrganization('Fanout Ltd');
    const one = await makeUser('ORG_ADMIN', { organizationId: org.id });
    const two = await makeUser('ORG_OFFICER', { organizationId: org.id });

    const ids = await prisma.$transaction((tx) =>
      notifyMany(tx, [one.user.id, two.user.id], {
        type: 'APPROVAL_REQUESTED',
        title: 'Approval needed',
        body: 'Something is waiting for you',
      }),
    );

    expect(ids).toHaveLength(2);
    expect(await prisma.notification.count()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The amount-suppression rule (plan 14 §B3)                                  */
/* -------------------------------------------------------------------------- */

describe('amount suppression during the sealed phase', () => {
  /**
   * **An officer whose phone shows "Acme Networks submitted a quotation of
   * ₹6,89,000" has defeated the entire sealing mechanism in plan 08.** This is
   * that rule, checked over every notification raised while the tender is still
   * sealed.
   */
  it('puts no bid amount in any notification body', async () => {
    const f = await bidFixture(3);
    const tender = await publishTender(f);

    const bids = [
      await placeBid(f, tender.id, 0, { prices: ['58500.00', '8200.00'] }),
      await placeBid(f, tender.id, 1, { prices: ['61000.00', '8600.00'] }),
    ];

    // Still sealed: the deadline has not passed and nothing was opened.
    const sealed = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(sealed.bidOpenedAt).toBeNull();

    const notifications = await prisma.notification.findMany();
    expect(notifications.length).toBeGreaterThan(0);

    for (const notification of notifications) {
      const text = `${notification.title} ${notification.body}`;

      for (const bid of bids) {
        expect(text, notification.type).not.toContain(bid.grandTotal);
        expect(text, notification.type).not.toContain(bid.subtotal);
        expect(text, notification.type).not.toContain(bid.taxableAmount);
      }

      // No rupee-shaped figure of any size, however it was formatted.
      expect(text, notification.type).not.toMatch(/₹\s?[\d,]{4,}/);
      // And no bare long digit run, which is how an unformatted amount looks.
      expect(text, notification.type).not.toMatch(/\d{5,}/);
    }
  });

  /** `QUOTATION_RECEIVED` is in-app only, precisely so no amount can be mailed. */
  it('never emails QUOTATION_RECEIVED', () => {
    expect(EMAIL_EVENTS.QUOTATION_RECEIVED).toBe(false);
    expect(EMAIL_EVENTS.QUOTATION_WITHDRAWN).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Email policy and retry                                                     */
/* -------------------------------------------------------------------------- */

describe('email policy', () => {
  it('decides for every notification type, with no gaps', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(EMAIL_EVENTS[type], type).toBeTypeOf('boolean');
    }
  });

  it('reports the policy as preferences the UI can render', () => {
    const prefs = notificationPreferences();

    expect(prefs).toHaveLength(NOTIFICATION_TYPES.length);
    for (const pref of prefs) {
      expect(pref.inApp).toBe(true);
      expect(pref.label.length).toBeGreaterThan(0);
    }
    expect(prefs.find((p) => p.type === 'QUOTATION_RECEIVED')!.email).toBe(false);
    expect(prefs.find((p) => p.type === 'TENDER_INVITED')!.email).toBe(true);
  });
});

describe('email retry', () => {
  it('reads the attempt count back out of the error text', () => {
    expect(attemptsOf({ emailError: null })).toBe(0);
    expect(attemptsOf({ emailError: 'attempt 2: connection refused' })).toBe(2);
  });

  it('retries a failed row and gives up after the cap', async () => {
    const org = await makeOrganization('Retry Ltd');
    const user = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const row = await prisma.$transaction((tx) =>
      notify(tx, {
        userId: user.user.id,
        type: 'APPROVAL_REQUESTED',
        title: 'Approval needed',
        body: 'Retry me',
      }),
    );

    // One previous failure: still inside the cap, so it is retried.
    await prisma.notification.update({
      where: { id: row.id },
      data: { emailError: 'attempt 1: connection refused' },
    });

    const first = await retryFailedEmails();
    expect(first.retried).toBe(1);
    // The console transport succeeds, so the row is now marked sent.
    const sent = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(sent.emailSentAt).toBeTruthy();
    expect(sent.emailError).toBeNull();

    // A row already at the cap is left alone.
    await prisma.notification.update({
      where: { id: row.id },
      data: { emailSentAt: null, emailError: `attempt ${MAX_EMAIL_ATTEMPTS}: still failing` },
    });

    const second = await retryFailedEmails();
    expect(second.retried).toBe(0);
  });

  it('ignores rows that never failed', async () => {
    const org = await makeOrganization('Clean Ltd');
    const user = await makeUser('ORG_ADMIN', { organizationId: org.id });
    await prisma.$transaction((tx) =>
      notify(tx, {
        userId: user.user.id,
        type: 'APPROVAL_REQUESTED',
        title: 'Nothing wrong here',
        body: 'No error recorded',
      }),
    );

    expect((await retryFailedEmails()).retried).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Templates                                                                  */
/* -------------------------------------------------------------------------- */

describe('templates', () => {
  it('renders the title and body it is handed, and nothing of its own', () => {
    const email = renderEmail({
      type: 'TENDER_INVITED',
      title: 'You have been invited to bid',
      body: 'Meridian Industries published a tender.',
      link: '/vendor/tenders/abc',
      recipientName: 'Asha',
    });

    expect(email.subject).toBe('You have been invited to bid');
    expect(email.text).toContain('Hello Asha,');
    expect(email.text).toContain('Meridian Industries published a tender.');
    expect(email.html).toContain('View the tender');
    expect(email.html).toContain('/vendor/tenders/abc');
  });

  it('escapes markup in the body rather than rendering it', () => {
    const email = renderEmail({
      type: 'APPROVAL_REQUESTED',
      title: 'Approval needed',
      body: '<script>alert(1)</script>',
      link: null,
      recipientName: null,
    });

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('prefixes the subject on the events that need urgency', () => {
    const email = renderEmail({
      type: 'GRN_REJECTION',
      title: 'Goods rejected on GRN/2025-26/000001',
      body: 'Line 1 was damaged.',
      link: null,
      recipientName: null,
    });
    expect(email.subject).toMatch(/^Action needed:/);
  });

  it('omits the button when there is nowhere to send the reader', () => {
    const email = renderEmail({
      type: 'PASSWORD_CHANGED',
      title: 'Your password changed',
      body: 'If this was not you, contact support.',
      link: null,
      recipientName: null,
    });
    expect(email.html).not.toContain('<a href');
  });
});

/* -------------------------------------------------------------------------- */
/* The bell endpoints                                                         */
/* -------------------------------------------------------------------------- */

describe('the bell', () => {
  async function seeded() {
    const org = await makeOrganization('Bell Ltd');
    const user = await makeUser('ORG_ADMIN', { organizationId: org.id });
    const other = await makeUser('ORG_OFFICER', { organizationId: org.id });

    await prisma.$transaction(async (tx) => {
      await notifyMany(tx, [user.user.id], {
        type: 'APPROVAL_REQUESTED',
        title: 'First',
        body: 'One',
      });
      await notifyMany(tx, [user.user.id], {
        type: 'TENDER_INVITED',
        title: 'Second',
        body: 'Two',
      });
      await notifyMany(tx, [other.user.id], {
        type: 'TENDER_INVITED',
        title: 'Not yours',
        body: 'Three',
      });
    });

    return { user, other };
  }

  it('lists only the actor own notifications', async () => {
    const { user } = await seeded();

    const res = await request(app)
      .get('/api/v1/notifications')
      .set(...user.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((n: { title: string }) => n.title)).not.toContain('Not yours');
  });

  it('counts the unread, per user', async () => {
    const { user, other } = await seeded();

    const mine = await request(app)
      .get('/api/v1/notifications/unread-count')
      .set(...user.authHeader);
    expect(mine.body.data.unread).toBe(2);

    const theirs = await request(app)
      .get('/api/v1/notifications/unread-count')
      .set(...other.authHeader);
    expect(theirs.body.data.unread).toBe(1);
  });

  it('marks one read, and filters by unread', async () => {
    const { user } = await seeded();
    const list = await request(app)
      .get('/api/v1/notifications')
      .set(...user.authHeader);
    const target = list.body.data[0].id;

    const marked = await request(app)
      .post(`/api/v1/notifications/${target}/read`)
      .set(...user.authHeader);
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect(marked.body.data.readAt).toBeTruthy();

    const unread = await request(app)
      .get('/api/v1/notifications?unread=true')
      .set(...user.authHeader);
    expect(unread.body.data).toHaveLength(1);
  });

  it('marks everything read in one call', async () => {
    const { user } = await seeded();

    const res = await request(app)
      .post('/api/v1/notifications/read-all')
      .set(...user.authHeader);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.marked).toBe(2);

    const after = await request(app)
      .get('/api/v1/notifications/unread-count')
      .set(...user.authHeader);
    expect(after.body.data.unread).toBe(0);
  });

  it("refuses to mark somebody else's notification read", async () => {
    const { user, other } = await seeded();
    const theirs = await prisma.notification.findFirstOrThrow({
      where: { userId: other.user.id },
    });

    await request(app)
      .post(`/api/v1/notifications/${theirs.id}/read`)
      .set(...user.authHeader)
      .expect(404);
  });

  it('serves the preference catalogue to any authenticated user', async () => {
    const { user } = await seeded();

    const res = await request(app)
      .get('/api/v1/me/notification-preferences')
      .set(...user.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(NOTIFICATION_TYPES.length);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/v1/notifications').expect(401);
    await request(app).get('/api/v1/notifications/unread-count').expect(401);
  });
});
