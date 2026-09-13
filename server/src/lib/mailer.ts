import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Best-effort mail. Never awaited on a request path and never allowed to throw:
 * a dead SMTP server must not take down registration or tender publishing
 * (defect C12).
 *
 * Plan 14 replaces the console fallback with a real nodemailer transport and
 * records the outcome on the Notification row. Until then, links are logged —
 * which is also how you grab an invitation link during local development.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

export function sendMail(mail: Mail): void {
  if (!smtpConfigured) {
    logger.info({ to: mail.to, subject: mail.subject, body: mail.text }, 'Mail (console fallback)');
    return;
  }

  // Plan 14 wires nodemailer here. Fire-and-forget by design.
  logger.info({ to: mail.to, subject: mail.subject }, 'Mail queued');
}
