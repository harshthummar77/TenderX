import cron, { type ScheduledTask } from 'node-cron';
import { isTest } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { runDeadlineSweep } from '../modules/tender/deadline.service.js';

/**
 * node-cron registry. One tick every 15 minutes — never every minute: a job
 * that queries the database each minute keeps the Neon compute awake 24/7 and
 * burns the entire free allowance (00 §7B).
 *
 * The sweeper is a **safety net**, not the mechanism. Deadlines are handled by
 * lazy-close-on-read, so bidding closes within seconds of anyone opening the
 * app; this catches tenders nobody looked at.
 */
export const EVERY_15_MINUTES = '*/15 * * * *';

const tasks: ScheduledTask[] = [];

export function registerJobs(): void {
  // Tests drive the sweep directly; a background timer would race the fixtures.
  if (isTest) return;

  tasks.push(
    cron.schedule(EVERY_15_MINUTES, () => {
      void runDeadlineSweep().catch((err) => logger.error({ err }, 'Deadline sweep failed'));
    }),
  );

  logger.info({ jobs: tasks.length, schedule: EVERY_15_MINUTES }, 'Job registry started');
}

export function stopJobs(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
  logger.info('Job registry stopped');
}
