import type { RequestHandler } from 'express';
import { verifyAuditChain } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import { ok } from '../../lib/response.js';
import { EMAIL_EVENTS } from '../notification/notification.service.js';

/**
 * System metrics (plan 19 §6).
 *
 * The four numbers a platform operator can act on: mail that never went out,
 * mail the provider refused, whether the audit chain still verifies, and how
 * long the database is taking to answer. Nothing here is per-tenant, so there is
 * no scoping to get wrong.
 *
 * This is the source of truth for the platform dashboard's health card too —
 * one probe, two consumers, so the screen and the monitor can never disagree.
 */

export interface SystemHealth {
  unsentNotifications: number;
  failedEmails24h: number;
  auditChainValid: boolean;
  auditRows: number;
  dbResponseMs: number;
}

/*
 * Only the types that actually send mail. `deliverEmail` returns early for the
 * in-app-only ones without stamping anything, so counting every row with a null
 * `emailSentAt` would report a permanent backlog that no sweep can ever clear —
 * which is worse than no metric, because it trains the operator to ignore it.
 */
const EMAILED_TYPES = Object.entries(EMAIL_EVENTS)
  .filter(([, sendsEmail]) => sendsEmail)
  .map(([type]) => type as keyof typeof EMAIL_EVENTS);

export async function systemHealth(): Promise<SystemHealth> {
  const since = new Date(Date.now() - 86_400_000);

  // Measured around a trivial query, so it reports round-trip latency to Neon
  // rather than the cost of whatever else is on the page.
  const probeStartedAt = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  const dbResponseMs = Date.now() - probeStartedAt;

  const [unsentNotifications, failedEmails24h, chain] = await Promise.all([
    prisma.notification.count({
      where: { type: { in: EMAILED_TYPES }, emailSentAt: null, emailError: null },
    }),
    prisma.notification.count({
      where: { emailSentAt: null, emailError: { not: null }, createdAt: { gte: since } },
    }),
    /*
     * Bounded: an operator wants to know the chain is intact, not to pay for a
     * full scan on every poll. The unbounded check is its own endpoint
     * (`/platform/activity/verify`, plan 14 §C3).
     */
    verifyAuditChain(prisma, 500),
  ]);

  return {
    unsentNotifications,
    failedEmails24h,
    auditChainValid: chain.valid,
    auditRows: chain.checked,
    dbResponseMs,
  };
}

/** `GET /platform/system` — pollable, and cheap enough to poll. */
export const system: RequestHandler = async (_req, res) => {
  ok(res, await systemHealth());
};
