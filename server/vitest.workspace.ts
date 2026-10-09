import { defineWorkspace } from 'vitest/config';

/**
 * Two projects (plan 18 §2).
 *
 * `unit` touches no database, so it runs in a watch loop on every save without
 * keeping the Neon compute awake (00 §7B). `integration` owns the one test
 * branch, which is why it must never run files in parallel: two workers would
 * truncate each other's data mid-test.
 *
 * Membership is by filename rather than folder: the suites were written
 * alongside their modules, and moving thirty files to prove a point would churn
 * every import for no behavioural gain. A spec belongs in UNIT only if nothing
 * it imports reaches Prisma.
 *
 * Both projects repeat their settings rather than `extends`-ing
 * `vitest.config.ts`: that indirection hangs the runner on Vitest 2.1.
 */
const UNIT = [
  'test/gstin.spec.ts',
  'test/match.spec.ts',
  'test/payable.spec.ts',
  'test/pricing.spec.ts',
  'test/scoring.spec.ts',
  'test/sealing.spec.ts',
  'test/stateMachines.spec.ts',
  'test/tax.spec.ts',
  'test/shared-utils.test.ts',
];

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      env: { NODE_ENV: 'test' },
      include: UNIT,
      // No database, so nothing to serialise and no reason to wait 30s.
      fileParallelism: true,
      testTimeout: 5_000,
      restoreMocks: true,
    },
  },
  {
    test: {
      name: 'integration',
      env: { NODE_ENV: 'test' },
      include: ['test/**/*.{test,spec}.ts'],
      exclude: ['node_modules/**', ...UNIT],
      // Every call is a round trip to Neon and bcrypt is deliberately slow, so
      // the 5s default aborts tests mid-request — and a TRUNCATE in the next
      // test then deadlocks against those still-running queries.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      fileParallelism: false,
      restoreMocks: true,
    },
  },
]);
