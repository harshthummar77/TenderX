import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests run against the Neon `test` branch (plan 18). No Docker anywhere.
    env: { NODE_ENV: 'test' },
    include: ['test/**/*.{test,spec}.ts'],
    // Every call is a round trip to Neon and bcrypt is deliberately slow, so the
    // 5s default aborts tests mid-request — and a TRUNCATE in the next test then
    // deadlocks against those still-running queries.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests truncate tables between files — never run files in parallel.
    fileParallelism: false,
    restoreMocks: true,
  },
});
