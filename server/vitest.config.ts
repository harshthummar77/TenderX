import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests run against the Neon `test` branch (plan 18). No Docker anywhere.
    env: { NODE_ENV: 'test' },
    include: ['test/**/*.test.ts'],
    // Integration tests truncate tables between files — never run files in parallel.
    fileParallelism: false,
    restoreMocks: true,
  },
});
