import type { Notification, Prisma } from '@prisma/client';
import type { NotificationPreferenceDto, NotificationQuery, NotificationType } from '@tb/shared';
import { NOTIFICATION_TYPES } from '@tb/shared';
import { NotFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import type { Actor } from '../../middleware/authenticate.js';
import { renderEmail } from './templates.js';
import { sendMail } from '../../lib/mailer.js';

/**
 * Notification delivery (plan 14 Part B).
 *
 * The write half lives in `lib/notify.ts` because it has to be callable from
 * inside every module's transaction. This file is the read half plus the email
 * dispatcher, and the retry the cron tick drives.
 *
 * Two properties hold the whole design up:
 *
 * 1. **The in-app notification is transactional.** It is written inside the
 *    caller's transaction, so if a tender publish rolls back the notification
 *    never existed. Nobody is ever told "you were invited to a tender that does
 *    not exist".
 * 2. **Email never blocks and never fails a request.** A dead SMTP server
 *    degrades the system to in-app only; `emailSentAt` and `emailError` record
 *    which happened.
 */

/**
 * Which events send email (plan 14 §B2).
 *
 * The in-app-only ones are deliberate, not an oversight. `QUOTATION_RECEIVED`
 * is the important case: emailing it during the sealed phase is how a bid amount
 * would escape to an officer's phone, so it stays inside the app where the
 * sealing rules apply. The others are high-frequency operational noise that
 * would train people to ignore the mail.
 */
export const EMAIL_EVENTS: Record<NotificationType, boolean> = {
  USER_INVITED: true,
  PASSWORD_CHANGED: true,
  VENDOR_APPROVED: true,
  VENDOR_REJECTED: true,
  VENDOR_SUSPENDED: true,
  TENDER_INVITED: true,
  TENDER_PUBLISHED: true,
  TENDER_CLOSING_SOON: true,
  TENDER_BIDDING_CLOSED: true,
  TENDER_CANCELLED: true,
  QUOTATION_RECEIVED: false,
  QUOTATION_WITHDRAWN: false,
  APPROVAL_REQUESTED: true,
  APPROVAL_APPROVED: true,
  APPROVAL_REJECTED: true,
  TENDER_AWARDED: true,
  QUOTATION_LOST: true,
  PO_ISSUED: true,
  PO_ACCEPTED: true,
  PO_REJECTED: true,
  DELIVERY_DISPATCHED: false,
  GRN_RECORDED: false,
  GRN_REJECTION: true,
  INVOICE_SUBMITTED: false,
  INVOICE_MATCH_EXCEPTION: true,
  INVOICE_APPROVED: true,
  INVOICE_REJECTED: true,
  PAYMENT_RECORDED: false,
  PAYMENT_COMPLETED: true,
};

const LABELS: Partial<Record<NotificationType, string>> = {
  USER_INVITED: 'You are invited to join an organization',
  VENDOR_APPROVED: 'Your vendor account was approved',
  TENDER_INVITED: 'You are invited to bid',
  TENDER_CLOSING_SOON: 'A bid deadline is approaching',
  QUOTATION_RECEIVED: 'A bid was received on your tender',
  APPROVAL_REQUESTED: 'Something needs your approval',
  TENDER_AWARDED: 'A tender was awarded to you',
  QUOTATION_LOST: 'A tender was awarded elsewhere',
  PO_ISSUED: 'A purchase order was issued to you',
  GRN_REJECTION: 'Goods were rejected on receipt',
  INVOICE_MATCH_EXCEPTION: 'An invoice failed the three-way match',
  INVOICE_APPROVED: 'An invoice was approved for payment',
  PAYMENT_COMPLETED: 'A payment was released',
};

const humanise = (type: string): string =>
  type
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function listNotifications(actor: Actor, query: NotificationQuery) {
  const where: Prisma.NotificationWhereInput = {
    // Always and only the actor's own. There is no cross-user notification read.
    userId: actor.userId,
    ...(query.unread === true ? { readAt: null } : {}),
    ...(query.unread === false ? { readAt: { not: null } } : {}),
    ...(query.type ? { type: query.type } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.notification.count({ where }),
  ]);

  return { rows, total, page: query.page, limit: query.limit };
}

/**
 * The number the bell shows. Polled every 60 seconds by the client, so it is a
 * single indexed count and nothing else — server-sent events were cut, and on a
 * serverless database a held-open connection is worse than a poll.
 */
export const unreadCount = (actor: Actor): Promise<number> =>
  prisma.notification.count({ where: { userId: actor.userId, readAt: null } });

export async function markRead(actor: Actor, id: string): Promise<Notification> {
  const notification = await prisma.notification.findFirst({
    where: { id, userId: actor.userId },
  });
  if (!notification) throw NotFound('Notification');
  if (notification.readAt) return notification;

  return prisma.notification.update({
    where: { id },
    data: { readAt: new Date() },
  });
}

export async function markAllRead(actor: Actor): Promise<number> {
  const { count } = await prisma.notification.updateMany({
    where: { userId: actor.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}

/**
 * The current notification policy, per event.
 *
 * Read-only: `User` has no column to persist a per-person override, so this
 * reports what the system actually does rather than inventing a setting that
 * would not be honoured. Making it editable is one `Json` column away and is
 * called out in the plan-14 notes.
 */
export const notificationPreferences = (): NotificationPreferenceDto[] =>
  NOTIFICATION_TYPES.map((type) => ({
    type,
    label: LABELS[type] ?? humanise(type),
    email: EMAIL_EVENTS[type] ?? false,
    inApp: true as const,
  }));

/* -------------------------------------------------------------------------- */
/* Email dispatch                                                             */
/* -------------------------------------------------------------------------- */

/** Attempts before a row is left alone (plan 14 §B1). */
export const MAX_EMAIL_ATTEMPTS = 3;

/**
 * Send the email for one notification, then record what happened.
 *
 * **Never throws.** It is called after the transaction has committed, so a
 * failure here must not undo a tender publish or an approval — it is recorded on
 * the row and retried by the cron tick.
 */
export async function deliverEmail(notificationId: string): Promise<boolean> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { user: { select: { email: true, fullName: true } } },
  });
  if (!notification) return false;
  if (notification.emailSentAt) return true;
  if (!EMAIL_EVENTS[notification.type]) return false;

  try {
    const email = renderEmail({
      type: notification.type,
      title: notification.title,
      body: notification.body,
      link: notification.link,
      recipientName: notification.user.fullName,
    });

    // Awaited: a rejection here is the whole point, it becomes `emailError`.
    await sendMail({
      to: notification.user.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });

    await prisma.notification.update({
      where: { id: notification.id },
      data: { emailSentAt: new Date(), emailError: null },
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown mail error';
    logger.warn({ err, notificationId }, 'Notification email failed');

    /*
     * The attempt count lives in the error string because there is no column for
     * it. Crude, but it keeps the retry capped without a migration, and the text
     * is what an operator reads anyway.
     */
    const attempts = (notification.emailError?.match(/attempt (\d+)/)?.[1] ?? '0') as string;
    const next = Number(attempts) + 1;

    await prisma.notification.update({
      where: { id: notification.id },
      data: { emailError: `attempt ${next}: ${message}`.slice(0, 500) },
    });
    return false;
  }
}

/** Attempts already made on a row, read back out of `emailError`. */
export const attemptsOf = (notification: Pick<Notification, 'emailError'>): number =>
  Number(notification.emailError?.match(/attempt (\d+)/)?.[1] ?? 0);

/**
 * Retry the emails that failed, capped at three attempts each.
 *
 * Runs on the existing 15-minute tick rather than its own timer: a worker
 * polling every minute keeps the Neon compute awake permanently and burns the
 * whole free allowance (00 §7B).
 */
export async function retryFailedEmails(): Promise<{ retried: number; sent: number }> {
  const pending = await prisma.notification.findMany({
    where: { emailSentAt: null, emailError: { not: null } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  let retried = 0;
  let sent = 0;

  for (const notification of pending) {
    if (attemptsOf(notification) >= MAX_EMAIL_ATTEMPTS) continue;
    retried += 1;
    if (await deliverEmail(notification.id)) sent += 1;
  }

  if (retried > 0) logger.info({ retried, sent }, 'Retried notification emails');
  return { retried, sent };
}
