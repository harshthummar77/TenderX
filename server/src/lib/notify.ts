import type { Prisma } from '@prisma/client';
import type { NotificationType } from '@tb/shared';
import { logger } from './logger.js';
import { sendMail } from './mailer.js';

/**
 * In-app notification, written **inside the caller's transaction** so it cannot
 * be lost if the state change succeeds (defect C12). The email is fired
 * afterwards, best-effort, and is never awaited on the request path.
 *
 * Plan 14 owns the notification module — list, mark-read, the sweeper that
 * retries unsent email. This is the write half it needs first.
 */

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
  link?: string | null;
}

export async function notify(tx: Prisma.TransactionClient, input: NotificationInput) {
  return tx.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      link: input.link ?? null,
    },
  });
}

export async function notifyMany(
  tx: Prisma.TransactionClient,
  userIds: string[],
  input: Omit<NotificationInput, 'userId'>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const userId of userIds) {
    const row = await notify(tx, { ...input, userId });
    ids.push(row.id);
  }
  return ids;
}

/**
 * Call AFTER the transaction commits. Failure here is logged, never thrown:
 * a dead SMTP server must not roll back an approval.
 *
 * This is the direct path, used where a module already knows its recipients. It
 * sends but records nothing, so a failure is only in the logs — prefer
 * `deliverNotificationEmails` for anything that should be retried.
 */
export function emailAfterCommit(recipients: { email: string }[], subject: string, text: string) {
  for (const recipient of recipients) {
    // Not awaited, and the rejection is swallowed on purpose: this runs after the
    // response has been decided and must never surface as an unhandled rejection.
    void sendMail({ to: recipient.email, subject, text }).catch((err: unknown) => {
      logger.warn({ err, to: recipient.email, subject }, 'Email failed after commit');
    });
  }
}

/**
 * The recorded path (plan 14 §B1).
 *
 * Takes the notification ids written inside the transaction and dispatches each
 * one through the template layer, stamping `emailSentAt` or `emailError` on the
 * row. That is what makes the outcome visible and the 15-minute retry sweep
 * possible: an email nobody recorded is an email nobody can resend.
 *
 * Imported lazily so `lib/notify` stays free of module-level dependencies on a
 * feature module — every service in the system imports this file.
 */
export function deliverNotificationEmails(notificationIds: string[]): void {
  if (notificationIds.length === 0) return;

  void (async () => {
    try {
      const { deliverEmail } = await import('../modules/notification/notification.service.js');
      for (const id of notificationIds) {
        await deliverEmail(id);
      }
    } catch (err) {
      logger.warn({ err }, 'Notification email dispatch failed');
    }
  })();
}
