import { logger } from '../lib/logger.js';
import { retryFailedEmails } from '../modules/notification/notification.service.js';

/**
 * Retry notification emails that failed (plan 14 §B1).
 *
 * It rides the existing 15-minute tick rather than running its own faster timer:
 * a worker polling every minute keeps the Neon compute awake permanently and
 * burns the whole free allowance (00 §7B). An email arriving fifteen minutes
 * late is a far smaller problem than a database that never sleeps.
 *
 * Capped at three attempts per row, so a permanently bad address is not retried
 * until the end of time.
 */
export async function runEmailRetrySweep(): Promise<void> {
  try {
    await retryFailedEmails();
  } catch (err) {
    // The sweep must never take the whole cron tick down with it.
    logger.error({ err }, 'Email retry sweep failed');
  }
}
