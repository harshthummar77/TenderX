import { Router } from 'express';
import type { HealthPayload, ReadyPayload } from '@tb/shared';
import { APP_VERSION } from '../../config/app.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { ok } from '../../lib/response.js';

export const healthRoutes = Router();

/**
 * Liveness. Render pings this constantly, so it must NOT touch the database —
 * a query per ping would keep the Neon compute awake permanently and burn the
 * whole free allowance (00 §7B).
 */
healthRoutes.get('/health', (_req, res) => {
  const payload: HealthPayload = {
    status: 'ok',
    uptime: Math.round(process.uptime()),
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  };
  ok(res, payload);
});

/**
 * Readiness. Runs SELECT 1. Call this by hand a minute before a demo to wake
 * both Render and the Neon compute.
 */
healthRoutes.get('/ready', async (req, res) => {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const payload: ReadyPayload = { db: 'ok', responseTimeMs: Date.now() - startedAt };
    ok(res, payload);
  } catch (err) {
    const responseTimeMs = Date.now() - startedAt;
    logger.error({ err, requestId: req.id, responseTimeMs }, 'Readiness check failed');
    // Failure keeps the standard envelope; the payload shape lives in the message.
    res.status(503).json({
      success: false,
      error: {
        code: 'db.unavailable',
        message: `Database is not reachable (${responseTimeMs}ms)`,
      },
      requestId: req.id,
    });
  }
});
