import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Mail transport (plan 14 §B4).
 *
 * Two transports behind one function:
 *
 * - **nodemailer over SMTP** when `SMTP_HOST`/`USER`/`PASS` are set (Gmail with
 *   an app password in dev and demo);
 * - **a console transport** when they are not, so **the app runs with no mail
 *   configuration at all**. A new contributor cloning the repo should not have
 *   to register for an SMTP account before they can publish a tender, and the
 *   logged body is also how you grab an invitation link locally.
 *
 * `sendMail` **rejects** when a configured transport fails. That is deliberate
 * and it is what makes `Notification.emailError` mean something: the caller
 * records the failure on the row and the 15-minute sweep retries it. Nothing on
 * a request path ever awaits this — see `emailAfterCommit`.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

let transporter: Transporter | null = null;

/** Built once, lazily: no connection is opened until something is actually sent. */
function getTransporter(): Transporter {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    // 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: (env.SMTP_PORT ?? 587) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  return transporter;
}

export const isMailConfigured = (): boolean => smtpConfigured;

/** Reset the memoised transport. Tests use it; nothing else should. */
export function resetMailer(): void {
  transporter = null;
}

export async function sendMail(mail: Mail): Promise<void> {
  if (!smtpConfigured) {
    logger.info(
      { to: mail.to, subject: mail.subject, body: mail.text },
      'Mail (console fallback)',
    );
    return;
  }

  await getTransporter().sendMail({
    from: env.SMTP_USER,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
  });

  logger.info({ to: mail.to, subject: mail.subject }, 'Mail sent');
}
