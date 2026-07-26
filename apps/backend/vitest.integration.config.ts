import { defineConfig } from 'vitest/config';

/**
 * Integration tests: the real app, a real database, a real Redis.
 *
 * Kept out of the default `test:unit` run on purpose. Unit tests must stay
 * runnable with no services on a laptop with no Docker; these cannot. Mixing
 * them means a developer with no database sees failures that say nothing about
 * their change.
 *
 * `singleThread` is not an optimisation here, it is correctness: the suites
 * share one Postgres and one Redis, and the rate-limit tests depend on a
 * request counter that concurrent files would race.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    setupFiles: ['src/test/setup.integration.ts'],
    // A cold start migrates the database and boots Prisma; the default 5s
    // timeout fails on the first test of a run rather than on a real problem.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/server.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
