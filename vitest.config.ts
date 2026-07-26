import { defineConfig } from 'vitest/config';

/**
 * Root test config — unit tests only.
 *
 * The admin dashboard is excluded because it needs a jsdom environment and a
 * React plugin; it carries its own `vitest.config.ts` and is run by its own
 * workspace script. Running it from the root would execute browser tests in a
 * node environment, where every render throws.
 *
 * `*.integration.test.ts` is excluded because those need a real Postgres and
 * Redis, which this run deliberately does not require. They were being
 * collected here and failing at import with "Invalid environment
 * configuration" on every machine without those services — and because vitest
 * reports a file that fails to import as zero tests, the summary line still
 * read "83 passed" while seven files had not run at all. A green-looking
 * number over silently skipped files is worse than a red one.
 *
 * Run them with `npm run test:integration -w @orbit/backend`, or both together
 * with `npm run test:coverage -w @orbit/backend`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.unit.ts'],
    include: ['packages/**/*.test.ts', 'apps/backend/**/*.test.ts', 'apps/mobile/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'apps/admin-dashboard/**',
      '**/*.integration.test.ts',
    ],
  },
});
