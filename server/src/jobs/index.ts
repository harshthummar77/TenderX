import type { ScheduledTask } from 'node-cron';
import { logger } from '../lib/logger.js';

/**
 * node-cron registry. One tick every 15 minutes — never every minute: a job
 * that queries the database each minute keeps the Neon compute awake 24/7 and
 * burns the entire free allowance (00 §7B).
 *
 * Deadline handling is lazy-close-on-read; cron is only the safety net for
 * tenders nobody looks at. Jobs are registered from plan 07 onward.
 */
export const EVERY_15_MINUTES = '*/15 * * * *';

const tasks: ScheduledTask[] = [];

export function registerJobs(): void {
  logger.info({ jobs: tasks.length }, 'Job registry started');
}

export function stopJobs(): void {
  for (const task of tasks) task.stop();
  logger.info('Job registry stopped');
}
