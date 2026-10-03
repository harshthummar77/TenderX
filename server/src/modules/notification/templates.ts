import type { NotificationType } from '@tb/shared';
import { env } from '../../config/env.js';

/**
 * Email templates (plan 14 §B4).
 *
 * One rendering function, driven by the notification row that was already
 * written transactionally. The title and body come from the service that raised
 * the event, so there is exactly one place each wording lives — a template that
 * re-derived the sentence could disagree with what the bell shows.
 *
 * **The amount-suppression rule (§B3) is why this file has no access to any
 * domain object.** It renders the `title` and `body` it is handed and composes
 * nothing of its own, so a template can never reintroduce an amount that the
 * sealing rules kept out of the notification. The suppression is enforced where
 * the body is written, and tested there.
 */

export interface EmailInput {
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  recipientName: string | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Events worth a stronger subject line than the title alone. */
const SUBJECT_PREFIX: Partial<Record<NotificationType, string>> = {
  GRN_REJECTION: 'Action needed',
  INVOICE_MATCH_EXCEPTION: 'Action needed',
  APPROVAL_REQUESTED: 'Approval needed',
  TENDER_CLOSING_SOON: 'Closing soon',
};

/** The one call to action, pointing into the app rather than at the API. */
const actionLabelFor = (type: NotificationType): string => {
  if (type === 'APPROVAL_REQUESTED') return 'Review the request';
  if (type === 'TENDER_INVITED') return 'View the tender';
  if (type === 'PO_ISSUED') return 'View the purchase order';
  if (type === 'INVOICE_MATCH_EXCEPTION') return 'Open the match checklist';
  if (type === 'PAYMENT_COMPLETED') return 'View the payment advice';
  return 'Open in TenderBridge';
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function renderEmail(input: EmailInput): RenderedEmail {
  const prefix = SUBJECT_PREFIX[input.type];
  const subject = prefix ? `${prefix}: ${input.title}` : input.title;
  const greeting = input.recipientName ? `Hello ${input.recipientName},` : 'Hello,';
  const url = input.link ? `${env.APP_URL}${input.link}` : null;

  const text = [
    greeting,
    '',
    input.body,
    ...(url ? ['', `${actionLabelFor(input.type)}: ${url}`] : []),
    '',
    'TenderBridge',
    'You are receiving this because of activity on your TenderBridge account.',
  ].join('\n');

  // Inlined styles: every mail client strips a <style> block sooner or later.
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e4e7eb;">
      <tr>
        <td style="padding:20px 24px;border-bottom:1px solid #e4e7eb;font-weight:600;font-size:15px;">
          TenderBridge
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 12px;font-size:14px;">${escapeHtml(greeting)}</p>
          <h1 style="margin:0 0 12px;font-size:17px;line-height:1.35;">${escapeHtml(input.title)}</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.5;">${escapeHtml(input.body)}</p>
          ${
            url
              ? `<a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#1f3a8a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">${escapeHtml(actionLabelFor(input.type))}</a>`
              : ''
          }
        </td>
      </tr>
      <tr>
        <td style="padding:16px 24px;border-top:1px solid #e4e7eb;font-size:12px;color:#616e7c;">
          You are receiving this because of activity on your TenderBridge account.
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}
