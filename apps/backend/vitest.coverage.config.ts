import { defineConfig } from 'vitest/config';

/**
 * Combined coverage: unit and integration suites in one run.
 *
 * Neither existing config answers "how much of the backend is tested". The
 * integration config runs only `*.integration.test.ts`, so a file like
 * `definition.schema.ts` — which has a 500-line unit test and is exercised
 * thoroughly — reported 8.6%. The root config runs only unit tests, so every
 * route file reports near zero. Both numbers are true and both are misleading.
 *
 * This config exists solely to produce the honest figure. It runs the same
 * tests the other two run, under the integration harness (which unit tests
 * tolerate: it configures environment variables and migrates a database they
 * simply never touch), and measures them together.
 *
 * It is not a replacement for either. `test` must stay runnable with no
 * services on a laptop with no Docker, and this cannot.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.integration.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'threads',
    // Correctness, not speed: the suites share one Postgres and one Redis, and
    // the rate-limit tests count requests that concurrent files would race.
    poolOptions: { threads: { singleThread: true } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/server.ts'],
      reporter: ['text-summary', 'json-summary', 'json'],
    },
  },
});
