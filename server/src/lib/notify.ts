import type { Prisma } from '@prisma/client';
import type { NotificationType } from '@tb/shared';
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
) {
  for (const userId of userIds) {
    await notify(tx, { ...input, userId });
  }
}

/**
 * Call AFTER the transaction commits. Failure here is logged, never thrown:
 * a dead SMTP server must not roll back an approval.
 */
export function emailAfterCommit(recipients: { email: string }[], subject: string, text: string) {
  for (const recipient of recipients) {
    sendMail({ to: recipient.email, subject, text });
  }
}
