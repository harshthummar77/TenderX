import { app } from './app.js';
import { APP_VERSION } from './config/app.js';
import { env } from './config/env.js';
import { registerJobs, stopJobs } from './jobs/index.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { initSentry, sentryEnabled } from './lib/sentry.js';

initSentry();

const server = app.listen(env.PORT, () =>
  logger.info({ port: env.PORT, version: APP_VERSION, sentry: sentryEnabled }, 'API up'),
);

registerJobs();

let shuttingDown = false;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Awaited, so in-flight requests finish before the pool closes. Render
    // sends SIGTERM and waits before it kills the instance (19 §9).
    await new Promise<void>((resolve) => server.close(() => resolve()));
    stopJobs();
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
