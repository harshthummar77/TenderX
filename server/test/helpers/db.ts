import { env } from '../../src/config/env.js';
import { prisma } from '../../src/lib/prisma.js';
import { clearActorCache } from '../../src/middleware/authenticate.js';

/**
 * Truncation helper for integration tests (formalised in plan 18).
 *
 * Two guards, because truncating the wrong branch is the one mistake in this
 * project that cannot be undone with a migration: NODE_ENV must be `test`, and
 * the connection string must name the Neon `test` endpoint. `.env.test` is
 * selected by env.ts, so both should always hold — these exist for the day
 * someone edits that by hand.
 */
const TEST_ENDPOINT = 'ep-icy-paper';

function assertTestDatabase() {
  if (env.NODE_ENV !== 'test') {
    throw new Error(`Refusing to truncate: NODE_ENV is "${env.NODE_ENV}", not "test"`);
  }
  if (!env.DATABASE_URL.includes(TEST_ENDPOINT)) {
    throw new Error(`Refusing to truncate: DATABASE_URL does not point at the ${TEST_ENDPOINT} branch`);
  }
}

/**
 * TRUNCATE, not DELETE: the audit table blocks DELETE with a rule, and CASCADE
 * plus RESTART IDENTITY resets the audit sequence so hash chains start clean.
 */
export async function truncateAll(): Promise<void> {
  assertTestDatabase();

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);

  clearActorCache();
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
