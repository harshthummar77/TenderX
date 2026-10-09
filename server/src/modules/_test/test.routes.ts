import { Router } from 'express';
import { isTest } from '../../config/env.js';
import { NotFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { ok } from '../../lib/response.js';
import { runVendorStatsSweep } from '../../jobs/refreshVendorStats.job.js';
import { runEmailRetrySweep } from '../../jobs/retryEmails.job.js';
import { remindAwaitingResponse } from '../purchase-order/po.service.js';
import { runDeadlineSweep } from '../tender/deadline.service.js';

/**
 * Test-only control surface (plan 18 §5).
 *
 * Mounted **only** when `NODE_ENV === 'test'`, and every handler re-checks, so
 * a mistake in `routes.ts` cannot expose it. There is no authentication here —
 * that is exactly why it must never reach a deployed environment.
 *
 * It exists so a browser test can cross a deadline or run a sweep deliberately
 * instead of sleeping. `waitForTimeout` for deadline logic is how suites become
 * flaky.
 */
export const testRoutes = Router();

/** Belt and braces: the guard lives on the route as well as on the mount. */
testRoutes.use((_req, _res, next) => {
  if (!isTest) throw NotFound('Route');
  next();
});

/**
 * Move deadlines into the past.
 *
 * The clock itself is not faked: nothing in this codebase takes an injectable
 * `now`, and threading one through every module to serve a test would be a far
 * bigger change than the test is worth. Shifting the data backwards reaches the
 * same state — a tender whose bidding window has closed — through the same code
 * paths a real expiry uses.
 */
testRoutes.post('/_test/advance-time', async (req, res) => {
  const hours = Number(req.body?.hours ?? 0);
  if (!Number.isFinite(hours) || hours <= 0) throw NotFound('hours must be a positive number');

  const ms = hours * 3_600_000;
  const tenderId = typeof req.body?.tenderId === 'string' ? req.body.tenderId : undefined;

  const tenders = await prisma.tender.findMany({
    where: {
      ...(tenderId ? { id: tenderId } : { status: 'PUBLISHED' }),
    },
    select: { id: true, bidSubmissionDeadline: true, deliveryDeadline: true },
  });

  for (const tender of tenders) {
    await prisma.tender.update({
      where: { id: tender.id },
      data: {
        bidSubmissionDeadline: new Date(tender.bidSubmissionDeadline.getTime() - ms),
        deliveryDeadline: new Date(tender.deliveryDeadline.getTime() - ms),
      },
    });
  }

  ok(res, { shifted: tenders.length, hours });
});

/**
 * Run one background sweep synchronously. The cron registry is disabled under
 * test (`registerJobs` returns early), so a test that wants the safety net has
 * to ask for it.
 */
const JOBS = {
  'deadline-sweep': runDeadlineSweep,
  'po-response': remindAwaitingResponse,
  'email-retry': runEmailRetrySweep,
  'vendor-stats': runVendorStatsSweep,
} as const;

testRoutes.post('/_test/run-job/:name', async (req, res) => {
  const name = req.params.name as keyof typeof JOBS;
  const job = JOBS[name];
  if (!job) throw NotFound(`Job "${String(name)}". Known: ${Object.keys(JOBS).join(', ')}`);

  ok(res, { job: name, result: (await job()) ?? null });
});
